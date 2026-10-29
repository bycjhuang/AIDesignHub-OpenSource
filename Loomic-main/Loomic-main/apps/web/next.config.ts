import type { NextConfig } from "next";
import path from "node:path";

const nextConfig: NextConfig = {
  output: "export",
  typescript: {
    ignoreBuildErrors: true,
  },
  webpack(config, { webpack }) {
    // The npm canvas carries an old Liberation font with incomplete notices.
    // Use the audited OFL 2.1.5 font for both webpack imports and public assets.
    config.plugins.push(new webpack.NormalModuleReplacementPlugin(
      /LiberationSans-Regular\.woff2$/,
      path.resolve(process.cwd(), "../../../../third_party/fonts/liberation-sans/LiberationSans-Regular.woff2"),
    ));
    return config;
  },
  env: {
    NEXT_PUBLIC_SERVER_BASE_URL: process.env.NEXT_PUBLIC_SERVER_BASE_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_HUB_LOCAL_RUNTIME: process.env.NEXT_PUBLIC_HUB_LOCAL_RUNTIME,
  },
};

export default nextConfig;
