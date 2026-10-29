import { openRsvpSession } from "./rsvp-session.mjs";
import { createTurnstile } from "./rsvp-turnstile.mjs";

const TEST_ENDPOINT =
  "https://wedding-rsvp-api-test.zakk-horren.workers.dev/rsvp";
const errors = {
  NETWORK_RETRY:
    "Не удалось получить подтверждение из-за сети. Ответы сохранены в этом браузере. Повторите отправку — новая анкета не создастся.",
  SERVER_RETRY:
    "Сервис временно недоступен. Успешное сохранение не подтверждено. Попробуйте ещё раз.",
  INVALID_SERVER_RESPONSE:
    "Сервис не подтвердил сохранение. Попробуйте ещё раз; ваши ответы сохранены.",
  TURNSTILE_RETRY:
    "Проверка безопасности истекла или не завершена. Пройдите её заново и повторите попытку.",
  TURNSTILE_UNAVAILABLE:
    "Не удалось загрузить проверку безопасности. Проверьте соединение или блокировщик и повторите попытку.",
  REVISION_CONFLICT:
    "Ответ уже изменился, возможно, организаторы обновили парковку. Загрузите актуальный ответ перед дальнейшим редактированием.",
  REVISION_OR_EPOCH_CONFLICT:
    "Версия ответа изменилась. Загрузите актуальную запись перед повторной отправкой.",
  EPOCH_CHANGED:
    "Состояние базы изменилось. Загрузите актуальный ответ перед повторной отправкой.",
  RESPONSE_ARCHIVED:
    "Ваш ответ находится в архиве у организаторов. Свяжитесь с ними для восстановления. Новую анкету создавать не нужно.",
  RESPONSE_DELETED:
    "Анкета удалена. Если хотите ответить снова, явно подтвердите создание новой анкеты.",
  STALE_IDENTITY:
    "Сохранённый идентификатор больше не действует. Для нового ответа подтвердите создание новой анкеты.",
  EDIT_KEY_INVALID:
    "Ссылка для редактирования недействительна. Проверьте её или свяжитесь с организаторами.",
  INVALID_EDIT_LINK:
    "Ссылка для редактирования повреждена. Откройте полную персональную ссылку.",
  LOCAL_IDENTITY_UNAVAILABLE:
    "Браузер не разрешает сохранить данные анкеты. Разрешите локальное хранилище и обновите страницу для проверки состояния ответа. Новую анкету создавать не нужно.",
  SESSION_CHANGED:
    "В другой вкладке открыта другая анкета. Обновите страницу, чтобы не заменить чужой ответ.",
  PENDING_REQUEST_RETRY_OR_RESTORE:
    "Предыдущая отправка ещё не подтверждена. Повторите её или загрузите актуальный ответ. Ваши исходные ответы сохранены.",
  RESTORE_REQUIRED:
    "Сначала загрузите актуальную анкету по персональной ссылке.",
  PREVIEW_DISABLED:
    "Тестовая отправка отключена. Откройте предварительную версию по инструкции проверки.",
  SITEKEY_REQUIRED:
    "Для проверки нужен публичный Turnstile sitekey. Укажите его в запуске предварительной версии.",
};
const conflicts = new Set([
  "REVISION_CONFLICT",
  "REVISION_OR_EPOCH_CONFLICT",
  "EPOCH_CHANGED",
  "RESTORE_REQUIRED",
]);
const deletions = new Set(["RESPONSE_DELETED", "STALE_IDENTITY"]);
const fatal = new Set([
  "RESPONSE_ARCHIVED",
  "EDIT_KEY_INVALID",
  "INVALID_EDIT_LINK",
  "LOCAL_IDENTITY_UNAVAILABLE",
  "SESSION_CHANGED",
  "PREVIEW_DISABLED",
  "SITEKEY_REQUIRED",
]);

export async function mountRsvp({
  config,
  entryUrl,
  form,
  syncCompany,
  resizeMessage,
  motionOK,
}) {
  const $ = (selector) => document.querySelector(selector);
  const feedback = $("#rsvp-feedback"),
    status = $("#rsvp-status");
  const retry = $("#rsvp-retry"),
    reload = $("#rsvp-reload"),
    fresh = $("#rsvp-new");
  const submitButton = $("#rsvp-submit"),
    success = $("#rsvp-success");
  let session,
    captcha,
    busy = false,
    blocked = true,
    pending = null,
    lastAction = "connect";
  let entry = entryUrl,
    restoreConfirmed = false;
  feedback.hidden = false;
  $("#mode-note").textContent = config?.local
    ? "Локальная проверка: ответы сохраняются только во временной базе этого окна. Организаторам ничего не отправляется."
    : "Предварительная версия: ответы отправляются только в тестовую базу.";

  function lock() {
    const locked = busy || blocked;
    form.querySelectorAll("input,textarea,button").forEach((el) => {
      el.disabled = locked;
    });
    if (!locked) syncCompany();
    form.setAttribute("aria-busy", String(busy));
    for (const button of [retry, reload, fresh]) button.disabled = busy;
    submitButton.textContent =
      busy && lastAction === "save" ? "Сохраняем…" : "Отправить ответ";
  }
  function notify(message, options = {}) {
    status.textContent = message;
    status.classList.toggle("rsvp-status-saved", options.saved === true);
    status.setAttribute("role", options.error ? "alert" : "status");
    retry.hidden = !options.retry;
    reload.hidden = !options.reload;
    fresh.hidden = !options.fresh;
  }
  function fill(answer) {
    for (const name of ["name", "message", "otherDrink", "additionalGuests"])
      form.elements[name].value = answer[name] || "";
    form.elements.guestCount.value = String(answer.guestCount || 1);
    form.elements.carCount.value = String(answer.carCount || 1);
    for (const input of form.querySelectorAll("[name=attending]"))
      input.checked = input.value === answer.attending;
    for (const input of form.querySelectorAll("[name=parking]"))
      input.checked = input.value === answer.parking;
    for (const input of form.querySelectorAll("[name=drinks]"))
      input.checked = (answer.drinks || []).includes(input.value);
    form.elements.consent.checked = answer.consent === true;
    syncCompany();
    resizeMessage();
  }
  function pendingAnswer() {
    try {
      return session?.pendingAnswer || null;
    } catch {
      return pending;
    }
  }
  function failure(error) {
    const code = error?.code || "SERVER_RETRY";
    pending = pendingAnswer();
    blocked =
      !session ||
      lastAction === "connect" ||
      Boolean(pending) ||
      conflicts.has(code) ||
      deletions.has(code) ||
      fatal.has(code);
    if (code === "RESPONSE_ARCHIVED") {
      form.hidden = true;
      success.hidden = true;
    }
    const message =
      lastAction === "connect" && code === "NETWORK_RETRY"
        ? "Не удалось загрузить анкету из-за сети. Проверьте соединение и повторите попытку."
        : errors[code];
    notify(
      message ||
        "Не удалось сохранить ответ. Проверьте поля и повторите попытку. Ваши данные не очищены.",
      {
        error: true,
        retry: !fatal.has(code) && !deletions.has(code) && !conflicts.has(code),
        reload:
          !!session &&
          !fatal.has(code) &&
          !deletions.has(code) &&
          (conflicts.has(code) || !!pending),
        fresh: deletions.has(code),
      },
    );
    lock();
    status.focus({ preventScroll: true });
  }
  function showSuccess(result) {
    fill(result.answer);
    form.hidden = true;
    success.hidden = false;
    const requestedParking =
      result.answer.attending === "Да, конечно!" &&
      result.answer.parking === "yes";
    const parkingText = !requestedParking
      ? ""
      : result.parkingStatus === "pending"
        ? " Заявка на парковку отправлена и ждёт отдельного подтверждения организаторов."
        : result.parkingStatus === "approved"
          ? " Организаторы подтвердили парковку для вашей компании."
          : result.parkingStatus === "rejected"
            ? " Заявка на парковку отклонена. При необходимости свяжитесь с организаторами."
            : "";
    $("#success-message").textContent = "Ваш ответ сохранён." + parkingText;
    const link = new URL(session.editLink());
    link.searchParams.set("rsvp_preview", "1");
    $("#rsvp-link").value = link.href;
    $("#rsvp-edit-link").hidden = false;
    $("#rsvp-copy-status").textContent = "";
    notify("Ответ восстановлен и доступен для редактирования в этом браузере.");
  }
  async function connect() {
    if (busy) return;
    busy = true;
    blocked = true;
    lastAction = "connect";
    lock();
    notify("Проверяем сохранённый ответ…");
    try {
      if (config?.enabled !== true || config.endpoint !== TEST_ENDPOINT)
        throw { code: "PREVIEW_DISABLED" };
      if (!config.turnstileSitekey?.trim()) throw { code: "SITEKEY_REQUIRED" };
      session = await openRsvpSession({
        endpoint: config.endpoint,
        pageUrl: entry,
      });
      entry = location.href; // The adapter already removed any private fragment.
      const saved = await session.restore();
      pending = pendingAnswer();
      if (pending) {
        fill(pending);
        form.hidden = false;
        success.hidden = true;
        blocked = true;
        lastAction = "save";
        notify(
          "Предыдущая отправка ещё не подтверждена. Ответы восстановлены. Повторите ту же отправку или загрузите актуальную запись.",
          { retry: true, reload: true },
        );
      } else if (saved) {
        blocked = false;
        showSuccess(saved);
      } else {
        blocked = false;
        form.hidden = false;
        success.hidden = true;
        notify(
          "Анкета готова. После сохранения вы получите персональную ссылку для редактирования.",
        );
      }
      captcha ||= createTurnstile(
        $("#rsvp-turnstile"),
        config.turnstileSitekey,
      );
      // Run independently: failure must not prevent reading an already saved answer.
      captcha.prepare().catch(() => {
        if (!busy && !form.hidden && !pending) {
          lastAction = "captcha";
          notify(errors.TURNSTILE_UNAVAILABLE, { error: true, retry: true });
        }
      });
    } catch (error) {
      entry = location.href;
      failure(error);
    } finally {
      busy = false;
      lock();
    }
  }
  async function submit(answer) {
    if (busy || !session) return;
    busy = true;
    lastAction = "save";
    lock();
    $("#form-error").hidden = true;
    notify("Сохраняем ответ. Дождитесь подтверждения…");
    try {
      captcha ||= createTurnstile(
        $("#rsvp-turnstile"),
        config.turnstileSitekey,
      );
      const result = await session.save(answer, () => captcha.token());
      pending = null;
      blocked = false;
      showSuccess(result);
      notify("Ваш ответ сохранён!", { saved: true });
      success.scrollIntoView({
        behavior: motionOK ? "smooth" : "auto",
        block: "center",
      });
    } catch (error) {
      failure(error);
    } finally {
      captcha?.reset();
      busy = false;
      lock();
    }
  }
  retry.addEventListener("click", async () => {
    if (busy) return;
    if (lastAction === "save" && pending) await submit(pending);
    else if (lastAction === "restore") await restoreLatest();
    else if (lastAction === "connect") await connect();
    else if (session) {
      try {
        captcha?.reset();
        await captcha?.prepare();
        notify(
          "Повторите отправку. Проверка безопасности будет выполнена перед сохранением.",
          { retry: !!pending },
        );
      } catch (error) {
        failure(error);
      }
    } else await connect();
  });
  async function restoreLatest() {
    if (busy) return;
    if (
      !restoreConfirmed &&
      !window.confirm(
        "Загрузить актуальный ответ? Несохранённые изменения в форме и предыдущая неподтверждённая отправка будут заменены данными из базы.",
      )
    )
      return;
    restoreConfirmed = true;
    busy = true;
    lastAction = "restore";
    lock();
    try {
      const saved = await session.restore({ discardPending: true });
      if (!saved) {
        pending = pendingAnswer();
        blocked = !!pending;
        notify(
          "В базе пока нет сохранённого ответа. Повторите исходную отправку.",
          { retry: !!pending },
        );
        lastAction = pending ? "save" : "connect";
      } else {
        pending = null;
        blocked = false;
        restoreConfirmed = false;
        fill(saved.answer);
        success.hidden = true;
        form.hidden = false;
        notify("Актуальный ответ загружен. Можно редактировать.");
      }
    } catch (error) {
      failure(error);
    } finally {
      busy = false;
      lock();
      resizeMessage();
    }
  }
  reload.addEventListener("click", restoreLatest);
  fresh.addEventListener("click", async () => {
    if (
      busy ||
      !window.confirm(
        "Предыдущая анкета удалена или её идентификатор устарел. Создать новую анкету?",
      )
    )
      return;
    busy = true;
    lock();
    try {
      if (!session) {
        session = await openRsvpSession({
          endpoint: config.endpoint,
          pageUrl: location.href,
        });
        try {
          await session.restore();
        } catch (error) {
          if (!deletions.has(error.code)) throw error;
        }
      }
      await session.startNewAfterDeletion(true);
      pending = null;
      blocked = false;
      form.hidden = false;
      success.hidden = true;
      captcha ||= createTurnstile(
        $("#rsvp-turnstile"),
        config.turnstileSitekey,
      );
      captcha.prepare().catch(() => {});
      notify("Новая анкета подготовлена. Ответ ещё не отправлен.");
    } catch (error) {
      failure(error);
    } finally {
      busy = false;
      lock();
    }
  });
  $("#edit-answer").addEventListener("click", () => {
    if (busy || blocked) return;
    success.hidden = true;
    form.hidden = false;
    lock();
    resizeMessage();
    notify("Измените ответы и нажмите «Отправить ответ».");
    form.scrollIntoView({
      behavior: motionOK ? "smooth" : "auto",
      block: "start",
    });
    form.elements.name.focus({ preventScroll: true });
  });
  $("#rsvp-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#rsvp-link").value);
      $("#rsvp-copy-status").textContent = "Ссылка скопирована.";
    } catch {
      $("#rsvp-link").focus();
      $("#rsvp-link").select();
      $("#rsvp-copy-status").textContent =
        "Ссылка выделена. Скопируйте её через меню браузера или Ctrl+C.";
    }
  });
  lock();
  await connect();
  return { submit };
}
