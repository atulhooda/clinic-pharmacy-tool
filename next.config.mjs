/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `pg` stays an external server package (as in Ritu Desk): bundling it breaks
  // its optional native bindings.
  experimental: {
    serverComponentsExternalPackages: ['pg'],
  },
};

export default nextConfig;
