import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import Unocss from 'unocss/vite'
import { viteSingleFile } from "vite-plugin-singlefile"
import { presetWind3, presetIcons, presetTypography, transformerDirectives, extractorSplit } from "unocss";
import extractorPug from '@unocss/extractor-pug'

import path from "path";
import { fileURLToPath } from "url";


const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);

export default defineConfig({
	clearScreen: false,
	preview: {
		host: true,
	},
	publicDir: "public",
	plugins: [
		vue(),
		Unocss({
			presets: [
				presetIcons({
					scale: 1.2,
				}),
				presetWind3(),
				presetTypography()
			],
			transformers: [
				transformerDirectives(),
			],
			extractors: [
				extractorPug(),
				extractorSplit,
			],
			theme: {
				breakpoints: {
					'xs': '320px',
				}
			}
		}),
		viteSingleFile(),
		addServiceWorkerScript(),
	],
	base: './',
	build: {
		outDir: "./dist/",
		sourcemap: false,
		assetsInlineLimit: 100000000,
		chunkSizeWarningLimit: 100000000,
		cssCodeSplit: false,

		rollupOptions: {
			output: {
				inlineDynamicImports: true,
			},
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



function addServiceWorkerScript() {
	return {
		name: 'vite-plugin-mini-sw',
		transformIndexHtml(html) {
			if (process.env.NODE_ENV === 'production') {
				return html.replace('</head>', `          
	<script>
    'serviceWorker' in navigator && window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js')});
  </script>
	</head>
	`);
			}
			return html;
		},
	};
}
