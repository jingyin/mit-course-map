"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

const PrereqGraph = dynamic(() => import("@/components/PrereqGraph"), {
  ssr: false,
  loading: () => (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        height: "100vh",
        fontSize: 14,
        color: "#666",
      }}
    >
      Loading prerequisite graph...
    </div>
  ),
});

export default function Home() {
  return (
    <Suspense>
      <PrereqGraph />
    </Suspense>
  );
}
