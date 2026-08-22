import { ImageResponse } from "next/og";

const SIZE = { width: 512, height: 512 };

// Content is padded to ~76% of the canvas — a safe zone so this same asset
// works for both a plain "any" icon and a "maskable" one (OS icon masks can
// crop up to ~20% from each edge).
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#f6f1e7",
        }}
      >
        <div
          style={{
            width: "76%",
            height: "76%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            borderRadius: "24%",
            background: "#c1502e",
          }}
        >
          <span
            style={{
              fontSize: 192,
              fontWeight: 700,
              color: "#f6f1e7",
              fontFamily: "monospace",
              letterSpacing: -6,
            }}
          >
            CL
          </span>
        </div>
      </div>
    ),
    SIZE
  );
}
