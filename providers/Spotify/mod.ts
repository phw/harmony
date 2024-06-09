import { ApiAccessToken, type CacheEntry, MetadataApiProvider, ReleaseApiLookup } from '@/providers/base.ts';
import { DurationPrecision, FeatureQuality, FeatureQualityMap } from '@/providers/features.ts';
import { parseHyphenatedDate, PartialDate } from '@/utils/date.ts';
import { ResponseError } from '@/utils/errors.ts';
import { selectLargestImage } from '@/utils/image.ts';
import { encodeBase64 } from 'std/encoding/base64.ts';
import { availableRegions } from './regions.ts';

import type {
	Album,
	ApiError,
	Copyright,
	ResultList,
	SearchResult,
	SimplifiedArtist,
	SimplifiedTrack,
	Track,
	TrackList,
} from './api_types.ts';
import type {
	ArtistCreditName,
	EntityId,
	HarmonyMedium,
	HarmonyRelease,
	HarmonyTrack,
	Label,
} from '@/harmonizer/types.ts';

// See https://developer.spotify.com/documentation/web-api

const spotifyClientId = Deno.env.get('HARMONY_SPOTIFY_CLIENT_ID') || '';
const spotifyClientSecret = Deno.env.get('HARMONY_SPOTIFY_CLIENT_SECRET') || '';

export default class SpotifyProvider extends MetadataApiProvider {
	readonly name = 'Spotify';

	readonly supportedUrls = new URLPattern({
		hostname: 'open.spotify.com',
		pathname: '{/intl-:region}?/:type(artist|album)/:id',
	});

	readonly features: FeatureQualityMap = {
		'cover size': 640,
		'duration precision': DurationPrecision.MS,
		'GTIN lookup': FeatureQuality.GOOD,
		'MBID resolving': FeatureQuality.GOOD,
		'release label': FeatureQuality.PRESENT,
	};

	readonly entityTypeMap = {
		artist: 'artist',
		release: 'album',
	};

	readonly availableRegions = new Set(availableRegions);

	readonly releaseLookup = SpotifyReleaseLookup;

	readonly launchDate: PartialDate = {
		year: 2008,
		month: 10,
	};

	readonly apiBaseUrl = 'https://api.spotify.com/v1/';

	constructUrl(entity: EntityId): URL {
		return new URL([entity.type, entity.id].join('/'), 'https://open.spotify.com');
	}

	async query<Data>(apiUrl: URL, maxTimestamp?: number): Promise<CacheEntry<Data>> {
		const accessToken = await this.cachedAccessToken(this.requestAccessToken);
		const cacheEntry = await this.fetchJSON<Data>(apiUrl, {
			policy: { maxTimestamp },
			requestInit: {
				headers: {
					'Authorization': `Bearer ${accessToken}`,
				},
			},
		});
		const { error } = cacheEntry.content as { error?: ApiError };

		if (error) {
			throw new SpotifyResponseError(error, apiUrl);
		}
		return cacheEntry;
	}

	private async requestAccessToken(): Promise<ApiAccessToken> {
		// See https://developer.spotify.com/documentation/web-api/tutorials/client-credentials-flow
		const url = new URL('https://accounts.spotify.com/api/token');
		const auth = encodeBase64(`${spotifyClientId}:${spotifyClientSecret}`);
		const body = new URLSearchParams();
		body.append('grant_type', 'client_credentials');

		const response = await fetch(url, {
			method: 'POST',
			headers: {
				'Authorization': `Basic ${auth}`,
				'Content-Type': 'application/x-www-form-urlencoded',
			},
			body: body,
		});

		const content = await response.json();
		return {
			accessToken: content?.access_token,
			validUntilTimestamp: Date.now() + (content.expires_in * 1000),
		};
	}
}

export class SpotifyReleaseLookup extends ReleaseApiLookup<SpotifyProvider, Album> {
	constructReleaseApiUrl(): URL {
		let lookupUrl: URL;
		const query = new URLSearchParams();
		if (this.lookup.method === 'gtin') {
			lookupUrl = new URL(`search`, this.provider.apiBaseUrl);
			query.set('type', 'album');
			query.set('q', `upc:${this.lookup.value}`);
		} else { // if (method === 'id')
			lookupUrl = new URL(`albums/${this.lookup.value}`, this.provider.apiBaseUrl);
		}

		lookupUrl.search = query.toString();
		return lookupUrl;
	}

	protected async getRawRelease(): Promise<Album> {
		if (this.lookup.method === 'gtin') {
			// Spotify does not always find UPC barcodes but expects them prefixed with
			// 0 to a length of 14 characters. E.g. "810121774182" gives no results,
			// but "00810121774182" does.
			let albumId: string | undefined;
			while (true) {
				const cacheEntry = await this.provider.query<SearchResult>(
					this.constructReleaseApiUrl(),
					this.options.snapshotMaxTimestamp,
				);
				if (cacheEntry.content?.albums?.items?.length) {
					albumId = cacheEntry.content.albums.items[0].id;
					break;
				} else if (this.lookup.value.length < 14) {
					// Prefix the GTIN with 0s
					this.lookup.value = this.lookup.value.padStart(14, '0');
				} else {
					// No results found
					break;
				}
			}

			// No results found
			if (!albumId) {
				throw new ResponseError(this.provider.name, 'API returned no results', this.constructReleaseApiUrl());
			}

			// Result is a SimplifiedAlbum. Perform a regular ID lookup with the found release
			// ID to retrieve complete data.
			this.lookup.method = 'id';
			this.lookup.value = albumId;
		}

		const cacheEntry = await this.provider.query<Album>(
			this.constructReleaseApiUrl(),
			this.options.snapshotMaxTimestamp,
		);
		const release = cacheEntry.content;

		this.updateCacheTime(cacheEntry.timestamp);
		return release;
	}

	private async getRawTracklist(rawRelease: Album): Promise<Track[]> {
		const allTracks: SimplifiedTrack[] = [...rawRelease.tracks.items];

		// The initial response contains max. 50 tracks. Fetch the remaining
		// tracks with separate requests if needed.
		let nextUrl = rawRelease.tracks.next;
		while (nextUrl && allTracks.length < rawRelease.tracks.total) {
			const cacheEntry = await this.provider.query<ResultList<SimplifiedTrack>>(
				new URL(nextUrl),
				this.options.snapshotMaxTimestamp,
			);
			this.updateCacheTime(cacheEntry.timestamp);
			allTracks.push(...cacheEntry.content.items);
			nextUrl = cacheEntry.content.next;
		}

		// Load full details including ISRCs
		return this.getRawTrackDetails(allTracks);
	}

	private async getRawTrackDetails(simplifiedTracks: SimplifiedTrack[]): Promise<Track[]> {
		const allTracks: Track[] = [];
		const trackIds = simplifiedTracks.map((track) => track.id);

		// The SimplifiedTrack entries do not contain ISRCs.
		// Perform track queries to obtain the full details of all tracks.
		// Each query can return up to 50 tracks.
		const maxResults = 50;
		const apiUrl = new URL('tracks', this.provider.apiBaseUrl);
		for (let index = 0; index < trackIds.length; index += maxResults) {
			apiUrl.searchParams.set('ids', trackIds.slice(index, index + maxResults).join(','));
			apiUrl.search = apiUrl.searchParams.toString();
			const cacheEntry = await this.provider.query<TrackList>(
				apiUrl,
				this.options.snapshotMaxTimestamp,
			);
			this.updateCacheTime(cacheEntry.timestamp);
			allTracks.push(...cacheEntry.content.tracks);
		}

		return allTracks;
	}

	protected async convertRawRelease(rawRelease: Album): Promise<HarmonyRelease> {
		this.id = rawRelease.id;
		const rawTracklist = await this.getRawTracklist(rawRelease);
		const media = this.convertRawTracklist(rawTracklist);
		const artwork = selectLargestImage(rawRelease.images, ['front']);
		return {
			title: rawRelease.name,
			artists: rawRelease.artists.map(this.convertRawArtist.bind(this)),
			gtin: rawRelease.external_ids.ean || rawRelease.external_ids.upc,
			externalLinks: [{
				url: new URL(rawRelease.external_urls.spotify),
				types: ['free streaming'],
			}],
			media,
			releaseDate: parseHyphenatedDate(rawRelease.release_date),
			copyright: this.getCopyright(rawRelease.copyrights),
			status: 'Official',
			packaging: 'None',
			images: artwork ? [artwork] : [],
			labels: this.getLabels(rawRelease),
			availableIn: rawRelease.available_markets,
			info: this.generateReleaseInfo(),
		};
	}

	private convertRawTracklist(tracklist: Track[]): HarmonyMedium[] {
		const result: HarmonyMedium[] = [];
		let medium: HarmonyMedium = {
			number: 1,
			format: 'Digital Media',
			tracklist: [],
		};

		// split flat tracklist into media
		tracklist.forEach((item) => {
			// store the previous medium and create a new one
			if (item.disc_number !== medium.number) {
				result.push(medium);

				medium = {
					number: item.disc_number,
					format: 'Digital Media',
					tracklist: [],
				};
			}

			medium.tracklist.push(this.convertRawTrack(item));
		});

		// store the final medium
		result.push(medium);

		return result;
	}

	private convertRawTrack(track: Track): HarmonyTrack {
		const result: HarmonyTrack = {
			number: track.track_number,
			title: track.name,
			length: track.duration_ms,
			isrc: track.external_ids.isrc,
			artists: track.artists.map(this.convertRawArtist.bind(this)),
			availableIn: track.available_markets,
		};

		return result;
	}

	private convertRawArtist(artist: SimplifiedArtist): ArtistCreditName {
		return {
			name: artist.name,
			creditedName: artist.name,
			externalIds: this.provider.makeExternalIds({ type: 'artist', id: artist.id }),
		};
	}

	private getLabels(rawRelease: Album): Label[] {
		// split label string using slashes if the results have at least 3 characters
		return rawRelease.label?.split(/(?<=[^/]{3,})\/(?=[^/]{3,})/).map((label) => ({
			name: label.trim(),
		}));
	}

	private getCopyright(copyrights: Copyright[]): string {
		return copyrights.map(this.formatCopyright).join('\n');
	}

	private formatCopyright(copyright: Copyright): string {
		// As Spotify provides separate fields for copyright and phonographic
		// copyright those get often entered without the corresponding symbol.
		// When only importing the text entry the information gets lost. Hence
		// prefix the entries with the © or ℗ symbol if it is not already present.
		let { text, type } = copyright;
		text = text.replace(/\(c\)/i, '©').replace(/\(p\)/i, '℗');
		if (!text.includes('©') && !text.includes('℗')) {
			text = `${type === 'P' ? '℗' : '©'} ${text}`;
		}
		return text;
	}
}

class SpotifyResponseError extends ResponseError {
	constructor(readonly details: ApiError, url: URL) {
		super('Spotify', details?.error?.message, url);
	}
}
