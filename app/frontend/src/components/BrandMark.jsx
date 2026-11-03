import React from "react";

// Monami brand mark — uses the official Monami logo PNG.
// The artwork is wide (≈2.13:1), so we size by height and derive the width to
// keep the mark crisp and visible instead of squashing it into a square.
const ASPECT = 706 / 331;

export default function BrandMark({ size = 48, className, title = "Monami" }) {
  const height = size;
  const width = Math.round(size * ASPECT);
  return (
    <img
      src="/monami-logo.png"
      alt={title}
      width={width}
      height={height}
      className={`monami-mark ${className || ""}`.trim()}
      style={{ width, height, objectFit: "contain" }}
      draggable={false}
      loading="eager"
    />
  );
}