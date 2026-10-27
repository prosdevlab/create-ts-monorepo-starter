import { nodeResolve } from '@rollup/plugin-node-resolve';
import license from 'rollup-plugin-license';

// Bundles the tsc output so published dist/ needs no runtime dependencies.
export default {
  input: 'build/cli.js',
  output: { file: 'dist/cli.js', format: 'esm' },
  external: [/^node:/],
  plugins: [nodeResolve(), license({ thirdParty: { output: 'dist/THIRD_PARTY_NOTICES.txt' } })],
};
