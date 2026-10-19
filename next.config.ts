import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // sharp stays external so Vercel reuses the platform-optimized build;
  // telegram (GramJS) is external so its node-only transports are not bundled
  serverExternalPackages: ["sharp", "telegram"],
  async headers() {
    return [
      {
        // v86 benefits from SharedArrayBuffer; COOP/COEP only for the terminal
        // page so the rest of the app keeps loading cross-origin assets.
        source: "/terminal",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
