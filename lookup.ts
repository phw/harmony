import { mergeRelease } from '@/harmonizer/merge.ts';
import { allProviders, allProviderSimpleNames, defaultProviderPreferences, providerMap } from '@/providers/mod.ts';
import { LookupError } from '@/utils/errors.ts';
import { ensureValidGTIN, isEqualGTIN } from '@/utils/gtin.ts';
import { formatLanguageConfidence, formatScriptFrequency } from '@/utils/locale.ts';
import { isDefined, isNotError } from '@/utils/predicate.ts';
import { detectScripts, scriptCodes } from '@/utils/script.ts';
import lande from 'lande';
import { zipObject } from 'utils/object/zipObject.js';
import { simplifyName } from 'utils/string/simplify.js';

import type {
	GTIN,
	HarmonyRelease,
	ProviderMessage,
	ProviderNameAndId,
	ProviderPreferences,
	ProviderReleaseMapping,
	ReleaseOptions,
} from '@/harmonizer/types.ts';

/** Parameters which can be used to lookup a release. */
export type ReleaseLookupParameters = {
	/** GTIN of the release. */
	gtin?: GTIN;
	/** Pairs of simplified provider names and provider IDs. */
	providerIds?: ProviderNameAndId[];
	/** Provider URLs. */
	urls?: URL[];
};

/**
 * Performs a combined lookup of a release with each of the given lookup parameters.
 *
 * Supports GTIN (has to be unique), provider IDs and URLs as input.
 * Each provider can only be used once, IDs will be used before URLs and GTIN.
 *
 * All remaining supported providers will be used for GTIN lookups, unless only specific providers have been requested.
 * GTIN lookups are only possible if the GTIN is available of course.
 */
export class CombinedReleaseLookup {
	constructor(lookup: ReleaseLookupParameters, options?: ReleaseOptions) {
		// Create a deep copy, we don't want to manipulate the caller's options later on.
		this.options = { ...options };
		this.gtinLookupProviders = new Set(options?.providers ?? allProviderSimpleNames);

		if (lookup.providerIds?.length) {
			for (const [providerSimpleName, id] of lookup.providerIds) {
				this.queueLookupById(providerSimpleName, id);
			}
		}
		if (lookup.urls?.length) {
			for (const url of lookup.urls) {
				this.queueLookupByUrl(url);
			}
		}
		if (this.gtinLookupProviders.size && lookup.gtin) {
			this.queueLookupsByGTIN(lookup.gtin);
		}
	}

	/** Initiates a new lookup by provider ID and adds it to the combined lookup. */
	queueLookupById(providerSimpleName: string, id: string): boolean {
		const provider = providerMap[providerSimpleName];
		if (provider) {
			const providerName = provider.name;
			if (this.queuedProviderNames.has(providerName)) {
				this.messages.push({
					type: 'error',
					text: `Provider ${providerName} can only be used once per lookup, ignoring ID '${id}'`,
				});
				return false;
			} else {
				this.queuedReleases.push(provider.getRelease(id, this.options));
				this.queuedProviderNames.add(providerName);
				this.gtinLookupProviders.delete(providerSimpleName);
				return true;
			}
		} else {
			this.messages.push({
				type: 'error',
				text: `There is no provider with the simplified name ${providerSimpleName}`,
			});
			return false;
		}
	}

	/** Initiates a new lookup by provider URL and adds it to the combined lookup. */
	queueLookupByUrl(url: URL): boolean {
		const provider = allProviders.find((provider) => provider.supportsDomain(url));
		if (provider) {
			const providerName = provider.name;
			if (this.queuedProviderNames.has(providerName)) {
				this.messages.push({
					type: 'error',
					text: `Provider ${providerName} can only be used once per lookup, ignoring ${url}`,
				});
				return false;
			} else {
				this.queuedReleases.push(provider.getRelease(url, this.options));
				this.queuedProviderNames.add(providerName);
				this.gtinLookupProviders.delete(simplifyName(providerName));
				return true;
			}
		} else {
			this.messages.push({
				type: 'error',
				text: `No provider supports ${url}`,
			});
			return false;
		}
	}

	/** Initiates new lookups by GTIN (for the remaining providers) and adds them to the combined lookup. */
	queueLookupsByGTIN(gtin: GTIN): boolean {
		// If the GTIN is already set, trying to change it is considered an error.
		if (this.gtin) {
			if (isEqualGTIN(gtin, this.gtin)) return true;
			this.messages.push({
				type: 'error',
				text: `Different GTIN '${gtin}' can not be combined with the current lookup`,
			});
			return false;
		}

		try {
			ensureValidGTIN(gtin);
		} catch (error) {
			this.messages.push({
				type: 'error',
				text: error.message,
			});
			return false;
		}
		this.gtin = gtin.toString();

		for (const providerSimpleName of this.gtinLookupProviders) {
			const provider = providerMap[providerSimpleName];
			if (provider) {
				this.queuedReleases.push(provider.getRelease(['gtin', this.gtin], this.options));
				this.queuedProviderNames.add(provider.name);
			} else {
				this.messages.push({
					type: 'error',
					text: `There is no provider with the simplified name ${providerSimpleName}`,
				});
			}
		}
		return true;
	}

	/** Finalizes all queued lookup requests and returns the provider release mapping. */
	async getProviderReleaseMapping(): Promise<ProviderReleaseMapping> {
		const releaseResults = await Promise.allSettled(this.queuedReleases);
		const releasesOrErrors: Array<HarmonyRelease | Error> = releaseResults.map((result) => {
			if (result.status === 'fulfilled') {
				return result.value;
			} else if (result.reason instanceof Error) {
				return result.reason;
			} else {
				return Error(result.reason);
			}
		});

		return zipObject(Array.from(this.queuedProviderNames), releasesOrErrors);
	}

	/** Ensures that all requested providers have been looked up and returns the provider release mapping. */
	async getCompleteProviderReleaseMapping(): Promise<ProviderReleaseMapping> {
		let releaseMap = await this.getProviderReleaseMapping();

		// We might still have providers left for which we have not done a lookup because the GTIN was not available.
		if (this.gtinLookupProviders.size && !this.gtin) {
			const releases = Object.values(releaseMap).filter(isNotError);

			// Use already used or available regions of the completed release lookups instead of the standard preferences.
			const usedRegions = releases.map((release) => release.info.providers[0].lookup.region).filter(isDefined);
			if (usedRegions.length) {
				this.options.regions = new Set(usedRegions);
			} else {
				const availableRegions = new Set(releases.flatMap((release) => release.availableIn ?? []));
				if (availableRegions.size) {
					// Remove all preferred regions where the release is unlikely to be available.
					if (this.options.regions?.size) {
						const availablePreferredRegions = new Set(this.options.regions);
						for (const region of availablePreferredRegions) {
							if (!availableRegions.has(region)) {
								availablePreferredRegions.delete(region);
							}
						}
						this.options.regions = availablePreferredRegions;
					}
					// Use available regions if no (available) preferred regions remain.
					if (!this.options.regions?.size) {
						this.options.regions = availableRegions;
					}
				}
			}

			// Obtain GTIN candidates from the already completed release lookups.
			const gtinCandidates = releases.map((release) => release.gtin).filter(isDefined);
			const uniqueGtinValues = new Set(gtinCandidates.map(Number));

			switch (uniqueGtinValues.size) {
				case 1:
					// Queue new lookups and get the updated release mapping.
					if (this.queueLookupsByGTIN(gtinCandidates[0])) {
						releaseMap = await this.getProviderReleaseMapping();
					}
					break;
				case 0: {
					const skippedProviders = Array.from(this.gtinLookupProviders)
						.map((simpleName) => providerMap[simpleName]?.name ?? simpleName);
					this.messages.push({
						type: 'info',
						text: `GTIN is unknown, lookups for the following providers were skipped: ${skippedProviders.join(', ')}`,
					});
					break;
				}
				default:
					this.messages.push({
						type: 'error',
						text: `Providers have returned multiple different GTIN: ${gtinCandidates.join(', ')}`,
					});
			}
		}

		return releaseMap;
	}

	/** Ensures that all requested providers have been looked up and returns the combined release. */
	async getMergedRelease(providerPreferences?: ProviderPreferences): Promise<HarmonyRelease> {
		const releaseMap = await this.getCompleteProviderReleaseMapping();
		const release = mergeRelease(releaseMap, providerPreferences);
		// Prepend error and warning messages of the combined lookup.
		release.info.messages.unshift(...this.messages);
		detectLanguageAndScript(release);

		return release;
	}

	private options: ReleaseOptions;
	private gtin: string | undefined;
	private gtinLookupProviders: Set<string>;
	private queuedReleases: Promise<HarmonyRelease>[] = [];
	private queuedProviderNames = new Set<string>();

	/** Warnings and errors from the combined lookup process. */
	messages: ProviderMessage[] = [];
}

/**
 * Looks up the given URL with the first matching provider.
 */
export function getReleaseByUrl(url: URL, options?: ReleaseOptions): Promise<HarmonyRelease> {
	const matchingProvider = allProviders.find((provider) => provider.supportsDomain(url));

	if (!matchingProvider) {
		throw new LookupError(`No provider supports ${url}`);
	}

	return matchingProvider.getRelease(url, options);
}

/**
 * Looks up the given GTIN with each provider and merges the resulting releases into one.
 */
export function getMergedReleaseByGTIN(
	gtin: GTIN,
	options?: ReleaseOptions,
): Promise<HarmonyRelease> {
	const lookup = new CombinedReleaseLookup({ gtin }, options);
	return lookup.getMergedRelease(defaultProviderPreferences);
}

/**
 * Looks up the given URL with the first matching provider.
 * Then tries to find that release on other providers (by GTIN) and merges the resulting data.
 */
export function getMergedReleaseByUrl(url: URL, options?: ReleaseOptions): Promise<HarmonyRelease> {
	const lookup = new CombinedReleaseLookup({ urls: [url] }, options);
	return lookup.getMergedRelease(defaultProviderPreferences);
}

function detectLanguageAndScript(release: HarmonyRelease): void {
	const allTitles = release.media.flatMap((medium) => medium.tracklist.map((track) => track.title));
	allTitles.push(release.title);

	if (!release.script) {
		const scripts = detectScripts(allTitles.join('\n'), scriptCodes);
		const mainScript = scripts[0];

		release.info.messages.push({
			type: 'debug',
			text: `Detected scripts of the titles: ${scripts.map(formatScriptFrequency).join(', ')}`,
		});

		if (mainScript?.frequency > 0.7) {
			release.script = mainScript;
		}
	}

	if (!release.language) {
		const guessedLanguages = lande(allTitles.join('\n'));
		const topLanguage = guessedLanguages[0];

		const formattedList = guessedLanguages
			.map(([code, confidence]) => ({ code, confidence }))
			.filter(({ confidence }) => confidence > 0.1)
			.map(formatLanguageConfidence);
		release.info.messages.push({
			type: 'debug',
			text: `Guessed language of the titles: ${formattedList.join(', ')}`,
		});

		if (topLanguage[1] > 0.7) {
			release.language = {
				code: topLanguage[0],
				confidence: topLanguage[1],
			};
		}
	}
}
