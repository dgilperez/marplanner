import { useState, useRef, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/credential";
import { readPublicDefaultCredentials } from "@/lib/default-credentials";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ErrorNotice } from "@/components/ErrorNotice";

/* ------------------------------------------------------------------ */
/* Shapes (contracts/openapi.yaml — VerifyPinRequest / VerifyPinResult */
/* ------------------------------------------------------------------ */

interface VerifyPinRequest {
  pin: string;
}

interface VerifyPinResult {
  match: boolean;
}

export interface AdminPinPadProps {
  /** Called once the entered PIN matched. The pad keeps no unlock state of its own. */
  onUnlock(): void;
  /** Called after Cancel dropped the entry in progress. */
  onCancel(): void;
  /** What the PIN unlocks, under the title. */
  description?: string;
}

/** The touch-first admin PIN entry (FR-017/018): the one PIN pad of the app, shown by the admin
 * gate and by a kiosk action that asks for the PIN. Its own copy is English by design: the gate
 * shows it before any settings read (ADR-061), so only `description` can be localized.
 */
export function AdminPinPad({
  onUnlock,
  onCancel,
  description = "Enter the admin PIN to unlock admin surfaces.",
}: AdminPinPadProps) {
  const [pin, setPin] = useState("");
  const [defaultPin] = useState(() => readPublicDefaultCredentials().adminPin);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /* -- pin submit ----------------------------------------------- */
  /*
   * The PIN is 4–6 digits and its length is not shown, so every length from 4 is tried as it is
   * reached. Attempts at 4 and 5 digits are silent probes: a rejection shows nothing and keeps
   * the digits so the parent keeps typing. A rejection at 6 digits, or of a manual submit (the
   * Unlock button or Enter), is the visible outcome: error plus cleared digits. Requests are
   * strictly sequential; a newer entry waits for the one in flight and only the latest waits.
   * `verify-pin` has no attempt counter (ADR-013: the PIN is advisory and the device key is the
   * authority), so probes cannot lock a household out.
   */

  const pinRef = useRef("");
  const inFlightRef = useRef<{ pin: string; visible: boolean } | null>(null);
  const queuedRef = useRef<{ pin: string; visible: boolean } | null>(null);
  // Bumped on cancel and unmount so a late answer for an abandoned entry is ignored.
  const generationRef = useRef(0);

  useEffect(
    () => () => {
      generationRef.current += 1;
    },
    []
  );

  const updatePin = useCallback((next: string) => {
    pinRef.current = next;
    setPin(next);
  }, []);

  const runVerification = useCallback(() => {
    const attempt = queuedRef.current;
    if (!attempt || inFlightRef.current) return;
    queuedRef.current = null;
    inFlightRef.current = attempt;
    const generation = generationRef.current;

    const settle = (outcome: "match" | "mismatch" | "failed") => {
      if (generation !== generationRef.current) return;
      // Read `visible` at settle time: a manual submit may have promoted this probe meanwhile.
      const visible = inFlightRef.current?.visible ?? false;
      inFlightRef.current = null;
      if (outcome === "match") {
        queuedRef.current = null;
        setSubmitting(false);
        updatePin("");
        onUnlock();
        return;
      }
      if (visible) {
        queuedRef.current = null;
        setSubmitting(false);
        updatePin("");
        setError(outcome === "mismatch" ? "Incorrect PIN." : "Request failed.");
        return;
      }
      runVerification();
    };

    authFetch("/api/auth/verify-pin", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pin: attempt.pin } satisfies VerifyPinRequest),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`verify-pin: ${res.status}`);
        return res.json() as Promise<VerifyPinResult>;
      })
      .then(
        (data) => settle(data.match ? "match" : "mismatch"),
        () => settle("failed")
      );
  }, [onUnlock, updatePin]);

  const requestVerification = useCallback(
    (candidate: string, visible: boolean) => {
      if (visible) {
        setSubmitting(true);
        setError(null);
      }
      const inFlight = inFlightRef.current;
      if (inFlight && inFlight.pin === candidate) {
        // The same digits are already on the wire: wait for that answer instead of resending.
        inFlight.visible ||= visible;
        queuedRef.current = null;
        return;
      }
      queuedRef.current = { pin: candidate, visible };
      runVerification();
    },
    [runVerification]
  );

  const handleSubmit = useCallback(() => {
    const current = pinRef.current;
    if (current.length < 4 || current.length > 6 || submitting) return;
    requestVerification(current, true);
  }, [submitting, requestVerification]);

  const addDigit = useCallback(
    (digit: string) => {
      const current = pinRef.current;
      if (submitting || current.length >= 6) return;
      const next = `${current}${digit}`;
      updatePin(next);
      setError(null);
      if (next.length >= 4) requestVerification(next, next.length === 6);
    },
    [submitting, updatePin, requestVerification]
  );

  const deleteDigit = useCallback(() => {
    if (submitting) return;
    // A probe already sent still settles; one not yet sent is for digits that no longer exist.
    queuedRef.current = null;
    updatePin(pinRef.current.slice(0, -1));
    setError(null);
  }, [submitting, updatePin]);

  /* -- hardware keyboard while the PIN gate is showing ------------ */

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("input, textarea, select, [contenteditable='true']")) return;

      if (event.key >= "0" && event.key <= "9") {
        event.preventDefault();
        addDigit(event.key);
        return;
      }
      if (event.key === "Backspace") {
        if (target?.closest?.("button")) return;
        event.preventDefault();
        deleteDigit();
        return;
      }
      if (event.key === "Enter") {
        // Focused keypad/unlock buttons activate via the control itself. Submitting here too
        // double-fires and can unlock mid tab-then-Enter digit entry (e2e keyboard flows).
        if (target?.closest?.("button, a, [role='button']")) return;
        event.preventDefault();
        handleSubmit();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addDigit, deleteDigit, handleSubmit]);

  const cancel = () => {
    generationRef.current += 1;
    inFlightRef.current = null;
    queuedRef.current = null;
    setSubmitting(false);
    updatePin("");
    setError(null);
    onCancel();
  };

  return (
    <Card className="w-full max-w-md shadow-lg">
      <CardHeader className="space-y-2 text-center">
        <CardTitle>Admin PIN</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex h-16 items-center justify-center">
          <output
            aria-label="Entered PIN"
            data-testid="admin-pin-display"
            className="min-w-48 text-center font-mono text-4xl tracking-[0.5em]"
          >
            {"●".repeat(pin.length)}
          </output>
        </div>
        {defaultPin && (
          <p
            role="note"
            className="rounded-md border border-destructive px-3 py-2 text-sm"
            data-testid="admin-pin-default-notice"
          >
            This instance uses the public default PIN <strong>{defaultPin}</strong>. Set your own
            MP_ADMIN_PIN before sharing its address.
          </p>
        )}
        <ErrorNotice id="admin-pin-error" message={error} />
        <div className="mx-auto grid max-w-70 grid-cols-3 gap-4" data-testid="admin-pin-keypad">
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => (
            <Button
              key={digit}
              type="button"
              variant="outline"
              size="lg"
              // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
              className="h-[64px] w-[64px] rounded-full text-[24px] font-semibold"
              aria-label={`Digit ${digit}`}
              data-testid={`admin-pin-digit-${digit}`}
              disabled={submitting || pin.length >= 6}
              onClick={() => addDigit(String(digit))}
            >
              {digit}
            </Button>
          ))}
          <Button
            type="button"
            variant="outline"
            size="lg"
            // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
            className="h-[64px] w-[64px] rounded-full text-[24px]"
            aria-label="Backspace"
            data-testid="admin-pin-backspace"
            disabled={submitting || pin.length === 0}
            onClick={deleteDigit}
          >
            ⌫
          </Button>
          <Button
            type="button"
            variant="outline"
            size="lg"
            // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
            className="h-[64px] w-[64px] rounded-full text-[24px] font-semibold"
            aria-label="Digit 0"
            data-testid="admin-pin-digit-0"
            disabled={submitting || pin.length >= 6}
            onClick={() => addDigit("0")}
          >
            0
          </Button>
          <Button
            type="button"
            size="lg"
            // eslint-disable-next-line ui-policy/sizing -- PIN keypad intentionally exceeds both density minima (64px target, 24px glyph); preserve accessible kiosk layout.
            className="h-[64px] w-[64px] rounded-full text-[24px]"
            aria-label="Unlock Admin"
            data-testid="admin-pin-unlock"
            disabled={submitting || pin.length < 4 || pin.length > 6}
            onClick={handleSubmit}
          >
            {submitting ? "…" : "→"}
          </Button>
        </div>
      </CardContent>
      <CardFooter>
        <Button
          type="button"
          variant="ghost"
          className="w-full"
          data-testid="admin-pin-cancel"
          onClick={cancel}
        >
          Cancel
        </Button>
      </CardFooter>
    </Card>
  );
}
