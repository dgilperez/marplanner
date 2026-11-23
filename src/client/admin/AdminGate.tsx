import { appPathname } from "@/lib/base-path";
import { useState, useRef, useEffect, useCallback } from "react";
import { isAdminPinBypassEnabled, useAdminUnlock } from "@/lib/adminUnlock";
import { AdminPinPad } from "./AdminPinPad";
import { AdminRoutes } from "./AdminRoutes";
import { LanguageProvider } from "@/i18n";
import { navigateHousehold } from "@/shell/routes";

/** Auto re-lock: unlock is ephemeral client state (`adminUnlock`). Complementary triggers:
 * 1. **Leave admin** — `AdminUnlockRouteReset` in `Shell.tsx` clears unlock when the route is
 *    no longer `kind: "admin"` (navigate to family surfaces).
 * 2. **Inactivity** (below) — parent finishes admin and walks away without Lock; timer is scoped
 *    to the admin panel element (capture-phase pointer/key/click), not `window`, so family-surface
 *    activity does not keep admin unlocked while the panel is open.
 * 3. **Explicit Lock** — `admin-lock-button` in `AdminContent` for immediate hand-back.
 * 4. **Refresh / close** — in-memory state is gone.
 * Five minutes is a recorded product judgement: short enough that an unattended kiosk does not
 * stay open all day, long enough that a parent re-reading a long list is not locked mid-task.
 */
const ADMIN_IDLE_LOCK_MS = 5 * 60 * 1000;

/* ------------------------------------------------------------------ */
/* AdminGate — touch-first PIN gate (FR-017/018) */
/* */
/* ADR-061 (60-66): the settings-backed LanguageProvider mounts */
/* INSIDE the admin-unlock subtree — the shell performs no boot-time */
/* /api probe. So the PRE-unlock PIN gate uses ENGLISH LITERALS by */
/* design; only */
/* the post-unlock admin content (AdminContent) is localized. */
/* Localizing the pre-unlock chrome is deferred to the */
/* i18n-localization domain. Guarded by */
/* tests/client/admin-gate-no-boot-probe.test.tsx. */
/* ------------------------------------------------------------------ */

export function AdminGate() {
  const { unlocked, setUnlocked } = useAdminUnlock();
  const bypassPin = isAdminPinBypassEnabled();
  const adminUnlocked = unlocked || bypassPin;
  const unlock = useCallback(() => setUnlocked(true), [setUnlocked]);

  /* -- auto re-lock ----------------------------------------------- */

  const adminPanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!adminUnlocked || bypassPin) return;
    // Attach idle listeners to the admin subtree, not `window`. `Shell.tsx` renders this gate and
    // the family surface as siblings, so window-scoped listeners let activity on the family
    // surface keep the admin panel unlocked. Only activity inside the panel resets the timer.
    const panel = adminPanelRef.current;
    if (!panel) return;

    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimer = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setUnlocked(false), ADMIN_IDLE_LOCK_MS);
    };

    resetIdleTimer();
    // CAPTURE phase, deliberately. On the bubble phase a single descendant calling
    // `stopPropagation` on keydown would make real user activity invisible to this timer and
    // lock a parent out mid-task — a silent failure with no way to diagnose it from the outside.
    // Nothing in the app or in Radix does that today; capture costs nothing and removes the class.
    //
    // `click` is in the set for the same reason the Options-menu Admin control accepts synthetic
    // activation: switch, voice-control and screen-reader users operate via clicks that
    // carry NO pointerdown and NO keydown. Without it, an AT user actively working in the panel is
    // locked out mid-task at the original deadline. For pointer users the click follows a
    // pointerdown, so the extra reset is idempotent.
    const opts = { capture: true } as const;
    panel.addEventListener("pointerdown", resetIdleTimer, opts);
    panel.addEventListener("keydown", resetIdleTimer, opts);
    panel.addEventListener("click", resetIdleTimer, opts);

    return () => {
      clearTimeout(idleTimer);
      panel.removeEventListener("pointerdown", resetIdleTimer, opts);
      panel.removeEventListener("keydown", resetIdleTimer, opts);
      panel.removeEventListener("click", resetIdleTimer, opts);
    };
  }, [adminUnlocked, bypassPin, setUnlocked]);

  /* -- unlocked: localized admin content (LanguageProvider mounts */
  /* HERE, post-unlock, so /api/settings fires only after unlock) */

  if (adminUnlocked) {
    return (
      <LanguageProvider>
        {/* `contents` creates no box, so layout is untouched; the element exists solely as the
 idle-timer's event scope (see the effect above). */}
        <div ref={adminPanelRef} className="contents" data-testid="admin-panel-scope">
          <AdminContent onLock={() => setUnlocked(false)} />
        </div>
      </LanguageProvider>
    );
  }

  /* -- locked: PIN gate (English, pre-unlock) -------------------- */

  const leaveAdmin = () => {
    const returnPath = window.history.state?.marplannerAdminReturnPath;
    if (typeof returnPath === "string" && !returnPath.startsWith("/admin")) {
      window.history.back();
      return;
    }
    navigateHousehold("/");
  };

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4">
      <AdminPinPad onUnlock={unlock} onCancel={leaveAdmin} />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AdminContent — the post-unlock, localized admin surface. Lives */
/* under LanguageProvider so the parent-facing admin NAV routes */
/* through t. The settings probe fires here, */
/* post-unlock, per ADR-061. */
/* ------------------------------------------------------------------ */

function AdminContent({ onLock }: { onLock: () => void }) {
  const adminPathname = () =>
    appPathname() === "/admin" || appPathname().startsWith("/admin/") ? appPathname() : "/admin";
  const [pathname, setPathname] = useState(adminPathname);

  useEffect(() => {
    const handlePopState = () => setPathname(adminPathname());
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  return <AdminRoutes pathname={pathname} onLock={onLock} />;
}
