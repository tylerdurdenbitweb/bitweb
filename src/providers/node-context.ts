/**
 * Node context - split from node.tsx so the provider file exports only the
 * component (React Fast Refresh constraint). All consumers import useNode
 * from here.
 */
import { createContext, useContext } from "react";
import type { NodeHandle } from "@/node/client";

export const NodeContext = createContext<NodeHandle | null>(null);

export function useNode(): NodeHandle {
  const n = useContext(NodeContext);
  if (!n) throw new Error("useNode outside NodeProvider");
  return n;
}
