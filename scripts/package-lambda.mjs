// Empaqueta la Lambda en un único archivo (dist-lambda/lambda.js) con esbuild.
import { build } from 'esbuild';
import { mkdirSync, rmSync } from 'node:fs';

rmSync('dist-lambda', { recursive: true, force: true });
mkdirSync('dist-lambda', { recursive: true });

await build({
  entryPoints: ['src/lambda.ts'],
  outfile: 'dist-lambda/lambda.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  minify: true,
  sourcemap: false,
  legalComments: 'none'
});
console.log('Paquete generado en dist-lambda/lambda.js (handler: lambda.handler)');
