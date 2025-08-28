import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Unocss from 'unocss/vite'
import { viteSingleFile } from "vite-plugin-singlefile"
import extractorPug from '@unocss/extractor-pug'

import path from "path";
import { fileURLToPath } from "url";


const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export default defineConfig({
	build: {
		copyPublicDir: false,
		lib: {
			entry: ['src/useHashFS.js'],
			formats: ['es'],
			fileName: 'index'
		},
		outDir: "./lib/",
		sourcemap: false,
		assetsInlineLimit: 100000000,
		chunkSizeWarningLimit: 100000000,
		rollupOptions: {
			external: ['vue'],
			output: {
				inlineDynamicImports: true,
				globals: {
					vue: 'Vue'
				}
			}
		}
	},
	worker: {
		format: 'es',
		rollupOptions: {
			output: {
				inlineDynamicImports: true,
			},
		}
	},
});

