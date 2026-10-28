// Prepared client adapter for API v2. Deliberately NOT loaded by the demo site.
import { normalizeAnswer } from "./worker/rsvp-policy.mjs";
export class RsvpSessionError extends Error {
  constructor(code) {
    super(code);
    this.name = "RsvpSessionError";
    this.code = code;
  }
}
const uuid =
  /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const keyPattern = /^[A-Za-z0-9_-]{43}$/;
const valid = (s) =>
  s &&
  uuid.test(s.id) &&
  keyPattern.test(s.key) &&
  (s.revision === null ||
    (Number.isSafeInteger(s.revision) && s.revision >= 0));
const canonical = (value) => JSON.stringify(value);
export async function openRsvpSession({
  endpoint,
  storage = globalThis.localStorage,
  pageUrl = globalThis.location?.href,
  history = globalThis.history,
  fetcher = fetch,
  locks = globalThis.navigator?.locks,
  confirmNewAfterDeletedLink = false,
} = {}) {
  const api = new URL(endpoint);
  if (
    api.protocol !== "https:" ||
    api.username ||
    api.password ||
    api.pathname !== "/rsvp" ||
    api.search ||
    api.hash
  )
    throw new RsvpSessionError("INVALID_ENDPOINT");
  const storageKey = "wedding.rsvp.v2:" + api.href;
  const lock = (fn) => (locks?.request ? locks.request(storageKey, fn) : fn());
  function load() {
    try {
      const raw = storage.getItem(storageKey);
      if (!raw) return null;
      const value = JSON.parse(raw);
      if (!valid(value)) throw Error();
      return value;
    } catch {
      throw new RsvpSessionError("LOCAL_IDENTITY_UNAVAILABLE");
    }
  }
  function persist(value) {
    try {
      storage.setItem(storageKey, JSON.stringify(value));
      if (storage.getItem(storageKey) !== JSON.stringify(value)) throw Error();
    } catch {
      throw new RsvpSessionError("LOCAL_IDENTITY_UNAVAILABLE");
    }
  }
  async function request(route, { method = "GET", body, secret } = {}) {
    let response;
    try {
      response = await fetcher(api.origin + route, {
        method,
        headers: {
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(secret ? { Authorization: "Bearer " + secret } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new RsvpSessionError("NETWORK_RETRY");
    }
    let result;
    try {
      result = await response.json();
    } catch {
      throw new RsvpSessionError("INVALID_SERVER_RESPONSE");
    }
    if (!response.ok) {
      const known = new Set([
        "RESPONSE_NOT_FOUND",
        "RESPONSE_DELETED",
        "STALE_IDENTITY",
        "EPOCH_CHANGED",
        "REVISION_CONFLICT",
        "REVISION_OR_EPOCH_CONFLICT",
        "TURNSTILE_RETRY",
        "TURNSTILE_UNAVAILABLE",
        "EDIT_KEY_INVALID",
        "REQUEST_ID_REUSED",
      ]);
      throw new RsvpSessionError(
        known.has(result.error) ? result.error : "SERVER_RETRY",
      );
    }
    if (result.ok !== true)
      throw new RsvpSessionError("INVALID_SERVER_RESPONSE");
    return result;
  }
  let deleted = false;
  const fragment = new URL(pageUrl).hash.slice(1),
    params = new URLSearchParams(fragment);
  const hasEdit = params.has("rsvp_id") || params.has("edit_key");
  if (hasEdit) {
    const clean = new URL(pageUrl);
    clean.hash = "";
    history?.replaceState(null, "", clean.href);
  }
  let imported = null;
  if (hasEdit) {
    imported = {
      id: params.get("rsvp_id")?.toLowerCase(),
      key: params.get("edit_key"),
      revision: null,
      epoch: null,
      pending: null,
    };
    if (!valid(imported)) throw new RsvpSessionError("INVALID_EDIT_LINK");
  }
  async function fresh() {
    const meta = await request("/rsvp/bootstrap");
    if (meta.protocol !== 2 || typeof meta.epoch !== "string")
      throw new RsvpSessionError("INVALID_SERVER_RESPONSE");
    return {
      id: crypto.randomUUID(),
      key: btoa(
        String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
      )
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
      revision: 0,
      epoch: meta.epoch,
      pending: null,
    };
  }
  let state = await lock(async () => {
    if (imported) {
      persist(imported);
      return imported;
    }
    const existing = load();
    if (existing) return existing;
    const value = await fresh();
    const concurrent = load();
    if (concurrent) return concurrent;
    persist(value);
    return value;
  });
  function current() {
    const stored = load();
    if (!stored || stored.id !== state.id || stored.key !== state.key)
      throw new RsvpSessionError("SESSION_CHANGED");
    return stored;
  }
  async function restore({ discardPending = false } = {}) {
    return lock(async () => {
      state = current();
      let result;
      try {
        result = await request("/rsvp/" + state.id, { secret: state.key });
      } catch (error) {
        if (
          error.code === "RESPONSE_NOT_FOUND" &&
          (state.revision === null || state.revision > 0)
        ) {
          deleted = true;
          throw new RsvpSessionError("RESPONSE_DELETED");
        }
        if (error.code === "RESPONSE_NOT_FOUND" && state.revision === 0)
          return null;
        throw error;
      }
      if (
        result.submissionId !== state.id ||
        !Number.isSafeInteger(result.revision) ||
        !result.saved
      )
        throw new RsvpSessionError("INVALID_SERVER_RESPONSE");
      if (!state.pending || discardPending) {
        state = {
          ...state,
          revision: result.revision,
          epoch: result.epoch,
          pending: null,
        };
        persist(state);
      }
      return result;
    });
  }
  if (imported)
    try {
      await restore();
    } catch (error) {
      if (
        error.code !== "RESPONSE_DELETED" ||
        confirmNewAfterDeletedLink !== true
      )
        throw error;
      state = await lock(async () => {
        const value = await fresh();
        persist(value);
        return value;
      });
      deleted = false;
    }
  return {
    get submissionId() {
      return state.id;
    },
    restore,
    editLink() {
      const link = new URL(pageUrl);
      link.search = "";
      link.hash = new URLSearchParams({
        rsvp_id: state.id,
        edit_key: state.key,
      }).toString();
      return link.href;
    },
    async save(raw, getTurnstileToken) {
      return lock(async () => {
        state = current();
        if (state.revision === null)
          throw new RsvpSessionError("RESTORE_REQUIRED");
        const answer = normalizeAnswer(raw);
        if (
          state.pending &&
          canonical(state.pending.answer) !== canonical(answer)
        )
          throw new RsvpSessionError("PENDING_REQUEST_RETRY_OR_RESTORE");
        if (!state.pending) {
          state = {
            ...state,
            pending: {
              requestId: crypto.randomUUID(),
              revision: state.revision,
              epoch: state.epoch,
              answer,
            },
          };
          persist(state);
        }
        let result;
        try {
          result = await request("/rsvp", {
            method: "POST",
            secret: state.key,
            body: {
              ...state.pending.answer,
              submissionId: state.id,
              requestId: state.pending.requestId,
              revision: state.pending.revision,
              epoch: state.pending.epoch,
              turnstileToken: await getTurnstileToken(),
            },
          });
        } catch (error) {
          if (["RESPONSE_DELETED", "STALE_IDENTITY"].includes(error.code))
            deleted = true;
          throw error;
        }
        if (
          result.saved !== true ||
          result.submissionId !== state.id ||
          !Number.isSafeInteger(result.revision)
        )
          throw new RsvpSessionError("INVALID_SERVER_RESPONSE");
        state = {
          ...state,
          revision: result.revision,
          epoch: result.epoch,
          pending: null,
        };
        persist(state);
        return result;
      });
    },
    async startNewAfterDeletion(confirm) {
      if (confirm !== true || !deleted)
        throw new RsvpSessionError("EXPLICIT_NEW_RESPONSE_REQUIRED");
      return lock(async () => {
        current();
        state = await fresh();
        persist(state);
        deleted = false;
        return state.id;
      });
    },
  };
}
