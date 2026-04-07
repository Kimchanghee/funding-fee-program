import type { NextConfig } from "next";
import { execSync } from "node:child_process";

const packageVersion = process.env.npm_package_version ?? "0.1.0";

function resolveGitSha(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "dev";
  }
}

const resolvedSha = (process.env.GIT_COMMIT_SHA ?? resolveGitSha()).slice(0, 8) || "dev";
const buildVersion = `${packageVersion}+${resolvedSha}`;
const buildDateIso = process.env.BUILD_DATE ?? new Date().toISOString();

const nextConfig: NextConfig = {
  output: "standalone",
  serverExternalPackages: ["ccxt", "ws"],
  env: {
    NEXT_PUBLIC_APP_VERSION: buildVersion,
    NEXT_PUBLIC_APP_BUILD_DATE: buildDateIso,
  },
};

export default nextConfig;
