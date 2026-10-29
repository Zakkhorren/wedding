const unavailable = () => ({ code: "TURNSTILE_UNAVAILABLE" });
let scriptReady;
function loadTurnstile() {
  if (globalThis.turnstile) return Promise.resolve();
  if (!scriptReady)
    scriptReady = new Promise((resolve, reject) => {
      const script = document.createElement("script");
      const timer = setTimeout(fail, 20000);
      function fail() {
        clearTimeout(timer);
        script.remove();
        scriptReady = null;
        reject(unavailable());
      }
      script.src =
        "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = () => {
        clearTimeout(timer);
        if (!globalThis.turnstile) {
          fail();
          return;
        }
        resolve();
      };
      script.onerror = fail;
      document.head.append(script);
    });
  return scriptReady;
}
export function createTurnstile(container, sitekey) {
  let widget,
    value = "",
    issued = 0,
    waiter,
    timer,
    preparing;
  function invalidate(code = "TURNSTILE_RETRY") {
    value = "";
    issued = 0;
    if (waiter) {
      clearTimeout(timer);
      waiter.reject({ code });
      waiter = null;
    }
  }
  async function prepare() {
    if (preparing) return preparing;
    preparing = (async () => {
      await loadTurnstile();
      container.hidden = false;
      if (widget !== undefined) return;
      widget = turnstile.render(container, {
        sitekey,
        action: "rsvp",
        language: "ru",
        theme: "light",
        size: "compact",
        appearance: "interaction-only",
        callback: (token) => {
          value = token;
          issued = Date.now();
          if (waiter) {
            clearTimeout(timer);
            waiter.resolve(token);
            waiter = null;
          }
        },
        "expired-callback": () => invalidate(),
        "timeout-callback": () => invalidate(),
        "error-callback": () => {
          invalidate("TURNSTILE_UNAVAILABLE");
          return true;
        },
      });
    })();
    try {
      await preparing;
    } finally {
      preparing = null;
    }
  }
  return {
    prepare,
    async token() {
      await prepare();
      if (value && Date.now() - issued < 270000) {
        const token = value;
        value = "";
        return token;
      }
      return new Promise((resolve, reject) => {
        waiter = { resolve, reject };
        timer = setTimeout(() => invalidate("TURNSTILE_RETRY"), 60000);
        try {
          turnstile.reset(widget);
        } catch {
          invalidate("TURNSTILE_UNAVAILABLE");
        }
      });
    },
    reset() {
      invalidate();
      if (widget !== undefined) {
        try {
          turnstile.reset(widget);
        } catch {
          /* Retry will surface widget errors. */
        }
      }
    },
  };
}
