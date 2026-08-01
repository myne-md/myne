// Desktop binding for the SHARED graph renderer (myne-md/myne#200).
//
// The renderer itself lives in `@myne/editor/host/notes/GraphCanvas` and is
// used verbatim by both clients. Only two things are per-client and they are
// exactly the two this file supplies: the worker constructor (its URL has to be
// statically analysable by THIS bundler) and the flush that persists positions
// to `vault.graph` through the platform seam. Kept at the old path with the old
// default export so `GraphView`'s `React.lazy(() => import("./GraphCanvas"))`
// boundary — which is what keeps d3 and the renderer out of the first-load
// bundle — is unchanged.

import type { ComponentProps } from "react";
import SharedGraphCanvas from "@myne/editor/host/notes/GraphCanvas";
import { scheduleGraphLayoutFlush } from "../graphLayoutPersist";

type SharedProps = ComponentProps<typeof SharedGraphCanvas>;

const makeLayoutWorker = () =>
  new Worker(new URL("../graphLayout.worker.ts", import.meta.url), {
    type: "module",
  });

export default function GraphCanvas(
  props: Omit<SharedProps, "makeWorker" | "onPositionsChanged">,
) {
  return (
    <SharedGraphCanvas
      {...props}
      makeWorker={makeLayoutWorker}
      onPositionsChanged={scheduleGraphLayoutFlush}
    />
  );
}
