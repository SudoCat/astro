import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	i18n: {
		defaultLocale: 'us',
		locales: ['us', 'fr'],
		routeTranslations: {
			fr: {
				about: 'a-propos',
				example: 'exemple',
			},
		},
	},
	experimental: {
		redirects: true,
	},
});
