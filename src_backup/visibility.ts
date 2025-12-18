import Orchestrator from "./orchestrator";

export function installVisibilityHandlers(orchestrator: Orchestrator) {
  let lastHiddenAt: number | null = null;

  async function onVisible() {
    const now = Date.now();
    const hiddenMs = lastHiddenAt ? now - lastHiddenAt : 0;
    lastHiddenAt = null;

    if (hiddenMs > 1000) {
      try {
        await orchestrator.refreshFromServer();
      } catch (e) {
        console.warn("[agent-dial] resume refresh failed", e);
      }
    } else {
      try {
        // Leg 3 (VMR -> external VTC) guard on quick tab switches
        orchestrator.ensureLeg3IfAgentReady();
      } catch {
        /* ignore */
      }
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      lastHiddenAt = Date.now();
    } else if (document.visibilityState === "visible") {
      void onVisible();
    }
  });

  // Optional: page lifecycle (Chrome) without ts-ignore/any
  const docWithDiscard = document as Document & { wasDiscarded?: boolean };
  if (docWithDiscard.wasDiscarded) {
    void orchestrator.refreshFromServer();
  }
}
