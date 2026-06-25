import React from "react";

export function PlusSettings() {
  return (
    <section className="tw-flex tw-flex-col tw-gap-4 tw-rounded-lg tw-bg-secondary tw-p-4">
      <div className="tw-flex tw-items-center tw-justify-between tw-gap-2 tw-text-xl tw-font-bold">
        <span>Copilot Plus</span>
      </div>
      <div className="tw-flex tw-flex-col tw-gap-2 tw-text-sm tw-text-muted">
        <div>
          <strong>Agent mode unlocked.</strong> This fork removes the Plus subscription requirement
          -- all features (agent mode, tool calling, web search, YouTube transcription, PDF/image
          support) work with your own API key.
        </div>
        <div>
          Configure your API key above, then switch to <strong>Copilot Plus (Beta)</strong> in the
          chat dropdown to use agent mode.
        </div>
      </div>
    </section>
  );
}
