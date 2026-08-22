import { ImageResponse } from "next/og";

const SIZE = { width: 192, height: 192 };

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
              fontSize: 72,
              fontWeight: 700,
              color: "#f6f1e7",
              fontFamily: "monospace",
              letterSpacing: -2,
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
