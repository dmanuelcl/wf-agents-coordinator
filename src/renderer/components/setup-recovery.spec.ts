import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { continueAfterSetupRepair, SetupRecoveryBanner } from "./setup-recovery";

describe("SetupRecoveryBanner", () => {
  it("offers a manual continuation only after setup needs repair", () => {
    const html = renderToStaticMarkup(
      createElement(SetupRecoveryBanner, {
        reason: "setup failed (exit 1)",
        completing: false,
        error: null,
        onContinue: () => {},
      }),
    );

    expect(html).toContain("Setup requiere intervención");
    expect(html).toContain("setup failed (exit 1)");
    expect(html).toContain("Continuar con los agentes");
    expect(html).not.toContain("disabled");
  });

  it("disables the continuation while setupDone is being persisted", () => {
    const html = renderToStaticMarkup(
      createElement(SetupRecoveryBanner, {
        reason: "setup failed (exit 1)",
        completing: true,
        error: null,
        onContinue: () => {},
      }),
    );

    expect(html).toContain("Desbloqueando…");
    expect(html).toContain("disabled");
  });
});

describe("continueAfterSetupRepair", () => {
  it("unlocks the normal flow only after setupDone is persisted", async () => {
    let finishPersisting: () => void = () => {};
    const persistence = new Promise<void>((resolve) => {
      finishPersisting = resolve;
    });
    const markSetupDone = vi.fn(() => persistence);
    const onReady = vi.fn();

    const completion = continueAfterSetupRepair({ sessionId: "session-1", markSetupDone, onReady });
    expect(markSetupDone).toHaveBeenCalledWith("session-1");
    expect(onReady).not.toHaveBeenCalled();

    finishPersisting();
    await completion;

    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("keeps the gate locked when setupDone cannot be persisted", async () => {
    const onReady = vi.fn();

    await expect(
      continueAfterSetupRepair({
        sessionId: "session-1",
        markSetupDone: async () => Promise.reject(new Error("disk full")),
        onReady,
      }),
    ).rejects.toThrow("disk full");

    expect(onReady).not.toHaveBeenCalled();
  });
});
