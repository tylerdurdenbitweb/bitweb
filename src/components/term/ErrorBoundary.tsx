import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
}
interface State {
  error: Error | null;
}

/**
 * Last line of defence: a render crash in any module must never white-screen
 * the whole terminal - show the fault in the house style and offer a reboot.
 * The chain, the wallet and the IndexedDB state are untouched by UI crashes.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown): void {
    console.error("[ui] module crash:", error, info);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <div className="mx-auto max-w-xl pt-16">
        <div className="border border-neutral-600 p-4 font-term text-sm leading-relaxed">
          <p className="mb-2 font-bold text-neutral-100">[ERR] MODULE CRASH - SEGMENT FAULT</p>
          <p className="break-all text-xs text-neutral-400">
            {this.state.error.message || String(this.state.error)}
          </p>
          <p className="mt-3 text-xs text-neutral-500">
            Your keys and the chain database are safe in this device's storage. Rebooting the
            terminal restores the session exactly where it left off.
          </p>
          <button
            className="term-btn term-btn-primary mt-4 px-6 py-2"
            onClick={() => window.location.reload()}
          >
            &gt; REBOOT TERMINAL
          </button>
        </div>
      </div>
    );
  }
}
