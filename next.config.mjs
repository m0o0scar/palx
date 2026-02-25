/** @type {import("next").NextConfig} */
const nextConfig = {
  allowedDevOrigins: ["localhost", "*.localhost", "127.0.0.1"],
  serverExternalPackages: ["keytar"],
  devIndicators: {
    position: "top-right",
  },
  experimental: {
    serverActions: {
      // Allow loopback iframe/proxy origins in local development previews.
      // Example host values: 127.0.0.1:55700
      allowedOrigins: ["127.0.0.*"],
    },
  },
  async rewrites() {
    return [
      {
        source: "/terminal/:path*",
        destination: "http://127.0.0.1:7681/:path*",
      },
    ];
  },
};

export default nextConfig;
