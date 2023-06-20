import type {
	AstroConfig,
	AstroSettings,
	InjectedRoute,
	ManifestData,
	RouteData,
	RoutePart,
} from '../../../@types/astro';
import type { LogOptions } from '../../logger/core';

import nodeFs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import slash from 'slash';
import { fileURLToPath } from 'url';
import { getPrerenderDefault } from '../../../prerender/utils.js';
import { SUPPORTED_MARKDOWN_FILE_EXTENSIONS } from '../../constants.js';
import { warn } from '../../logger/core.js';
import { removeLeadingForwardSlash } from '../../path.js';
import { resolvePages } from '../../util.js';
import { getRouteGenerator } from './generator.js';
const require = createRequire(import.meta.url);

interface Item {
	basename: string;
	ext: string;
	parts: RoutePart[];
	file: string;
	isDir: boolean;
	isIndex: boolean;
	isPage: boolean;
	routeSuffix: string;
}

function countOccurrences(needle: string, haystack: string) {
	let count = 0;
	for (let i = 0; i < haystack.length; i += 1) {
		if (haystack[i] === needle) count += 1;
	}
	return count;
}

function getParts(part: string, file: string) {
	const result: RoutePart[] = [];
	part.split(/\[(.+?\(.+?\)|.+?)\]/).map((str, i) => {
		if (!str) return;
		const dynamic = i % 2 === 1;

		const [, content] = dynamic ? /([^(]+)$/.exec(str) || [null, null] : [null, str];

		if (!content || (dynamic && !/^(\.\.\.)?[a-zA-Z0-9_$]+$/.test(content))) {
			throw new Error(`Invalid route ${file} — parameter name must match /^[a-zA-Z0-9_$]+$/`);
		}

		result.push({
			content,
			dynamic,
			spread: dynamic && /^\.{3}.+$/.test(content),
		});
	});

	return result;
}

function areSamePart(a: RoutePart, b: RoutePart) {
	return a.content === b.content && a.dynamic === b.dynamic && a.spread === b.spread;
}

function getPattern(
	segments: RoutePart[][],
	base: string,
	addTrailingSlash: AstroConfig['trailingSlash']
) {
	const pathname = segments
		.map((segment) => {
			if (segment.length === 1 && segment[0].spread) {
				return '(?:\\/(.*?))?';
			} else {
				return (
					'\\/' +
					segment
						.map((part) => {
							if (part.locale) {
								return `(${part.locale})`;
							}
							else if (part.spread) {
								return '(.*?)';
							} else if (part.dynamic) {
								return '([^/]+?)';
							} else {
								return part.content
									.normalize()
									.replace(/\?/g, '%3F')
									.replace(/#/g, '%23')
									.replace(/%5B/g, '[')
									.replace(/%5D/g, ']')
									.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
							}
						})
						.join('')
				);
			}
		})
		.join('');

	const trailing =
		addTrailingSlash && segments.length ? getTrailingSlashPattern(addTrailingSlash) : '$';
	let initial = '\\/';
	if (addTrailingSlash === 'never' && base !== '/') {
		initial = '';
	}
	return new RegExp(`^${pathname || initial}${trailing}`);
}

function getTrailingSlashPattern(addTrailingSlash: AstroConfig['trailingSlash']): string {
	if (addTrailingSlash === 'always') {
		return '\\/$';
	}
	if (addTrailingSlash === 'never') {
		return '$';
	}
	return '\\/?$';
}

function isSpread(str: string) {
	const spreadPattern = /\[\.{3}/g;
	return spreadPattern.test(str);
}

function validateSegment(segment: string, file = '') {
	if (!file) file = segment;

	if (/\]\[/.test(segment)) {
		throw new Error(`Invalid route ${file} \u2014 parameters must be separated`);
	}
	if (countOccurrences('[', segment) !== countOccurrences(']', segment)) {
		throw new Error(`Invalid route ${file} \u2014 brackets are unbalanced`);
	}
	if (
		(/.+\[\.\.\.[^\]]+\]/.test(segment) || /\[\.\.\.[^\]]+\].+/.test(segment)) &&
		file.endsWith('.astro')
	) {
		throw new Error(`Invalid route ${file} \u2014 rest parameter must be a standalone segment`);
	}
}

function comparator(a: Item, b: Item) {
	if (a.isIndex !== b.isIndex) {
		if (a.isIndex) return isSpread(a.file) ? 1 : -1;

		return isSpread(b.file) ? -1 : 1;
	}

	const max = Math.max(a.parts.length, b.parts.length);

	for (let i = 0; i < max; i += 1) {
		const aSubPart = a.parts[i];
		const bSubPart = b.parts[i];

		if (!aSubPart) return 1; // b is more specific, so goes first
		if (!bSubPart) return -1;

		// if spread && index, order later
		if (aSubPart.spread && bSubPart.spread) {
			return a.isIndex ? 1 : -1;
		}

		// If one is ...spread order it later
		if (aSubPart.spread !== bSubPart.spread) return aSubPart.spread ? 1 : -1;

		if (aSubPart.dynamic !== bSubPart.dynamic) {
			return aSubPart.dynamic ? 1 : -1;
		}

		if (!aSubPart.dynamic && aSubPart.content !== bSubPart.content) {
			return (
				bSubPart.content.length - aSubPart.content.length ||
				(aSubPart.content < bSubPart.content ? -1 : 1)
			);
		}
	}

	// endpoints are prioritized over pages
	if (a.isPage !== b.isPage) {
		return a.isPage ? 1 : -1;
	}

	// otherwise sort alphabetically
	return a.file < b.file ? -1 : 1;
}

function injectedRouteToItem(
	{ config, cwd }: { config: AstroConfig; cwd?: string },
	{ pattern, entryPoint }: InjectedRoute
): Item {
	const resolved = require.resolve(entryPoint, { paths: [cwd || fileURLToPath(config.root)] });

	const ext = path.extname(pattern);

	const type = resolved.endsWith('.astro') ? 'page' : 'endpoint';
	const isPage = type === 'page';

	return {
		basename: pattern,
		ext,
		parts: getParts(pattern, resolved),
		file: resolved,
		isDir: false,
		isIndex: true,
		isPage,
		routeSuffix: pattern.slice(pattern.indexOf('.'), -ext.length),
	};
}

// Seeings if the two routes are siblings of each other, with `b` being the route
// in focus. If it is in the same parent folder as `a`, they are siblings.
function areSiblings(a: RouteData, b: RouteData) {
	if (a.segments.length < b.segments.length) return false;
	for (let i = 0; i < b.segments.length - 1; i++) {
		let segment = b.segments[i];
		if (segment.length === a.segments[i].length) {
			for (let j = 0; j < segment.length; j++) {
				if (!areSamePart(segment[j], a.segments[i][j])) {
					return false;
				}
			}
		} else {
			return false;
		}
	}
	return true;
}

export interface CreateRouteManifestParams {
	/** Astro Settings object */
	settings: AstroSettings;
	/** Current working directory */
	cwd?: string;
	/** fs module, for testing */
	fsMod?: typeof nodeFs;
}

/** Create manifest of all static routes */
export function createRouteManifest(
	{ settings, cwd, fsMod }: CreateRouteManifestParams,
	logging: LogOptions
): ManifestData {
	const components: string[] = [];
	let routes: RouteData[] = [];
	const validPageExtensions: Set<string> = new Set([
		'.astro',
		...SUPPORTED_MARKDOWN_FILE_EXTENSIONS,
		...settings.pageExtensions,
	]);
	const validEndpointExtensions: Set<string> = new Set(['.js', '.ts']);
	const localFs = fsMod ?? nodeFs;
	const prerender = getPrerenderDefault(settings.config);

	const foundInvalidFileExtensions: Set<string> = new Set();

	function walk(
		fs: typeof nodeFs,
		dir: string,
		parentSegments: RoutePart[][],
		parentParams: string[]
	) {
		let items: Item[] = [];
		fs.readdirSync(dir).forEach((basename) => {
			const resolved = path.join(dir, basename);
			const file = slash(path.relative(cwd || fileURLToPath(settings.config.root), resolved));
			const isDir = fs.statSync(resolved).isDirectory();

			const ext = path.extname(basename);
			const name = ext ? basename.slice(0, -ext.length) : basename;

			if (name[0] === '_') {
				return;
			}
			if (basename[0] === '.' && basename !== '.well-known') {
				return;
			}
			// filter out "foo.astro_tmp" files, etc
			if (!isDir && !validPageExtensions.has(ext) && !validEndpointExtensions.has(ext)) {
				if (!foundInvalidFileExtensions.has(ext)) {
					foundInvalidFileExtensions.add(ext);
					warn(logging, 'astro', `Invalid file extension for Pages: ${ext}`);
				}

				return;
			}
			const segment = isDir ? basename : name;
			validateSegment(segment, file);

			const parts = getParts(segment, file);
			const isIndex = isDir ? false : basename.startsWith('index.');
			const routeSuffix = basename.slice(basename.indexOf('.'), -ext.length);
			const isPage = validPageExtensions.has(ext);

			items.push({
				basename,
				ext,
				parts,
				file: file.replace(/\\/g, '/'),
				isDir,
				isIndex,
				isPage,
				routeSuffix,
			});
		});
		items = items.sort(comparator);

		items.forEach((item) => {
			const segments = parentSegments.slice();

			if (item.isIndex) {
				if (item.routeSuffix) {
					if (segments.length > 0) {
						const lastSegment = segments[segments.length - 1].slice();
						const lastPart = lastSegment[lastSegment.length - 1];

						if (lastPart.dynamic) {
							lastSegment.push({
								dynamic: false,
								spread: false,
								content: item.routeSuffix,
							});
						} else {
							lastSegment[lastSegment.length - 1] = {
								dynamic: false,
								spread: false,
								content: `${lastPart.content}${item.routeSuffix}`,
							};
						}

						segments[segments.length - 1] = lastSegment;
					} else {
						segments.push(item.parts);
					}
				}
			} else {
				segments.push(item.parts);
			}

			const params = parentParams.slice();
			params.push(...item.parts.filter((p) => p.dynamic).map((p) => p.content));

			if (item.isDir) {
				walk(fsMod ?? fs, path.join(dir, item.basename), segments, params);
			} else {
				components.push(item.file);
				const component = item.file;
				const trailingSlash = item.isPage ? settings.config.trailingSlash : 'never';
				const pattern = getPattern(segments, settings.config.base, trailingSlash);
				const generate = getRouteGenerator(segments, trailingSlash);
				const pathname = segments.every((segment) => segment.length === 1 && !segment[0].dynamic)
					? `/${segments.map((segment) => segment[0].content).join('/')}`
					: null;
				const route = `/${segments
					.map(([{ dynamic, content }]) => (dynamic ? `[${content}]` : content))
					.join('/')}`.toLowerCase();
				routes.push({
					route,
					type: item.isPage ? 'page' : 'endpoint',
					pattern,
					segments,
					params,
					component,
					generate,
					pathname: pathname || undefined,
					prerender,
				});
			}
		});
	}

	const { config } = settings;
	const pages = resolvePages(config);

	if (localFs.existsSync(pages)) {
		walk(localFs, fileURLToPath(pages), [], []);
	} else if (settings.injectedRoutes.length === 0) {
		const pagesDirRootRelative = pages.href.slice(settings.config.root.href.length);

		warn(logging, 'astro', `Missing pages directory: ${pagesDirRootRelative}`);
	}

	settings.injectedRoutes
		?.sort((a, b) =>
			// sort injected routes in the same way as user-defined routes
			comparator(injectedRouteToItem({ config, cwd }, a), injectedRouteToItem({ config, cwd }, b))
		)
		.reverse() // prepend to the routes array from lowest to highest priority
		.forEach(({ pattern: name, entryPoint }) => {
			let resolved: string;
			try {
				resolved = require.resolve(entryPoint, { paths: [cwd || fileURLToPath(config.root)] });
			} catch (e) {
				resolved = fileURLToPath(new URL(entryPoint, config.root));
			}
			const component = slash(path.relative(cwd || fileURLToPath(config.root), resolved));

			const segments = removeLeadingForwardSlash(name)
				.split(path.posix.sep)
				.filter(Boolean)
				.map((s: string) => {
					validateSegment(s);
					return getParts(s, component);
				});

			const type = resolved.endsWith('.astro') ? 'page' : 'endpoint';
			const isPage = type === 'page';
			const trailingSlash = isPage ? config.trailingSlash : 'never';

			const pattern = getPattern(segments, settings.config.base, trailingSlash);
			const generate = getRouteGenerator(segments, trailingSlash);
			const pathname = segments.every((segment) => segment.length === 1 && !segment[0].dynamic)
				? `/${segments.map((segment) => segment[0].content).join('/')}`
				: null;
			const params = segments
				.flat()
				.filter((p) => p.dynamic)
				.map((p) => p.content);
			const route = `/${segments
				.map(([{ dynamic, content }]) => (dynamic ? `[${content}]` : content))
				.join('/')}`.toLowerCase();

			const collision = routes.find(({ route: r }) => r === route);
			if (collision) {
				throw new Error(
					`An integration attempted to inject a route that is already used in your project: "${route}" at "${component}". \nThis route collides with: "${collision.component}".`
				);
			}

			// the routes array was already sorted by priority,
			// pushing to the front of the list ensure that injected routes
			// are given priority over all user-provided routes
			routes.unshift({
				type,
				route,
				pattern,
				segments,
				params,
				component,
				generate,
				pathname: pathname || void 0,
				prerender,
			});
		});

	if (config.i18n) {
		const { locales, routeTranslations, defaultLocale, enableDefaultPrefix, localizeEndpoints } = config.i18n;
		const localizationRedirects: RouteData[] = [];

		routes = routes.reduce<RouteData[]>((all, data) => {
			if (data.type === 'endpoint' && !localizeEndpoints) return all;
			return all.concat(
				locales.map((locale) => {
					const localizeRoute = locale !== defaultLocale || enableDefaultPrefix;
					const segments = [...data.segments];
					let { route } = data;
					if (localizeRoute) {
						segments.unshift([{ content: 'locale', dynamic: true, spread: false, locale }]);
					}
					if (routeTranslations?.[locale]) {
						Object.entries(routeTranslations[locale]).forEach(([key, value]) => route = route.replace(key, value))
						segments.forEach(outer => outer.map(inner => {
							return {
								...inner,
								content: routeTranslations[locale]?.[inner.content] || inner.content
							}
						}))
					}
					if (!localizeRoute) {
						data.segments = segments;
						data.route = route;
						return data;
					}
					const trailingSlash = data.type === 'page' ? settings.config.trailingSlash : 'never';
					const localeRoute = {
						...data,
						segments,
						route: `/[locale]${route}`,
						params: ['locale', ...data.params],
						generate: getRouteGenerator(segments, trailingSlash),
						pattern: getPattern(segments, settings.config.base, trailingSlash),
						pathname: undefined,
					};
					if (locale === defaultLocale && enableDefaultPrefix) {
						localizationRedirects.push({
							...data,
							component: data.route,
							type: 'redirect',
							prerender: false,
							redirect: `/${locale}${route}`,
							redirectRoute: undefined,
							// redirectRoute: localeRoute,
						});
					}
					return localeRoute;
				})
			);
		}, []);

		// Add redirects at end of array
		routes.push(...localizationRedirects);
	}

	Object.entries(settings.config.redirects).forEach(([from, to]) => {
		const trailingSlash = config.trailingSlash;

		const segments = removeLeadingForwardSlash(from)
			.split(path.posix.sep)
			.filter(Boolean)
			.map((s: string) => {
				validateSegment(s);
				return getParts(s, from);
			});

		const pattern = getPattern(segments, settings.config.base, trailingSlash);
		const generate = getRouteGenerator(segments, trailingSlash);
		const pathname = segments.every((segment) => segment.length === 1 && !segment[0].dynamic)
			? `/${segments.map((segment) => segment[0].content).join('/')}`
			: null;
		const params = segments
			.flat()
			.filter((p) => p.dynamic)
			.map((p) => p.content);
		const route = `/${segments
			.map(([{ dynamic, content }]) => (dynamic ? `[${content}]` : content))
			.join('/')}`.toLowerCase();

		const routeData: RouteData = {
			type: 'redirect',
			route,
			pattern,
			segments,
			params,
			component: from,
			generate,
			pathname: pathname || void 0,
			prerender: false,
			redirect: to,
			redirectRoute: routes.find((r) => r.route === to),
		};

		// Push so that redirects are selected last.
		routes.push(routeData);
	});

	return {
		routes,
	};
}
