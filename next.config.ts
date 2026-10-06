import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: false,
  // sharp stays external so Vercel reuses the platform-optimized build
  serverExternalPackages: ["sharp"],
};

export default nextConfig;
