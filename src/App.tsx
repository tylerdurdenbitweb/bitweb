import { lazy, Suspense } from "react";
import { Routes, Route, Link } from "react-router";
import { Layout } from "@/components/term/Layout";
import { ErrorBoundary } from "@/components/term/ErrorBoundary";
import Terminal from "./pages/Terminal";

// Secondary pages load on demand - the landing Terminal stays eager so
// first paint never waits on a chunk (and the QR vendor code only downloads
// when a page that renders codes is actually visited).
const Wallet = lazy(() => import("./pages/Wallet"));
const Transfers = lazy(() => import("./pages/Transfers"));
const Manifesto = lazy(() => import("./pages/Manifesto"));

function PageLoader() {
  return (
    <div className="py-16 text-center font-term text-sm text-neutral-500">
      LOADING MODULE ...<span className="blink">_</span>
    </div>
  );
}

function NotFound() {
  return (
    <div className="mx-auto max-w-xl space-y-4 pt-16 text-center">
      <pre className="ascii glow text-neutral-100">
        {String.raw`
 _  _    ____    _  _
| || |  / __ \  | || |
| || |_| |  | | | || |_
|__   _| |  | | |__   _|
   | | | |__| |    | |
   |_|  \____/    |_|  `}
      </pre>
      <p className="font-term text-2xl">SECTOR NOT FOUND</p>
      <p className="text-xs text-neutral-500">
        The requested block of reality does not exist on this chain.
      </p>
      <Link className="term-btn inline-block" to="/">
        &gt; RETURN TO TERMINAL
      </Link>
    </div>
  );
}

export default function App() {
  return (
    <Layout>
      <ErrorBoundary>
        <Routes>
          <Route path="/" element={<Terminal />} />
          <Route
            path="/wallet"
            element={
              <Suspense fallback={<PageLoader />}>
                <Wallet />
              </Suspense>
            }
          />
          <Route
            path="/transfers"
            element={
              <Suspense fallback={<PageLoader />}>
                <Transfers />
              </Suspense>
            }
          />
          <Route
            path="/manifesto"
            element={
              <Suspense fallback={<PageLoader />}>
                <Manifesto />
              </Suspense>
            }
          />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </ErrorBoundary>
    </Layout>
  );
}
