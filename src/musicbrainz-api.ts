import * as querystring from 'querystring';
import * as assert from 'assert';

import Axios, {AxiosInstance, AxiosProxyConfig, AxiosResponse} from 'axios';

import * as HttpStatus from 'http-status-codes';
import * as url from 'url';
import * as Debug from 'debug';

export {XmlMetadata} from './xml/xml-metadata';
export {XmlIsrc} from './xml/xml-isrc';
export {XmlIsrcList} from './xml/xml-isrc-list';
export {XmlRecording} from './xml/xml-recording';

import {XmlMetadata} from './xml/xml-metadata';
import {DigestAuth} from './digest-auth';

import {enableCookies, getCookies} from './axios-cookie-handler';
import {RateLimiter} from './rate-limiter';
import * as mb from './musicbrainz.types';
import {ISearchQuery} from "./musicbrainz.types";

export * from './musicbrainz.types';

const retries = 3;

type Includes =
  'artists'
  | 'releases'
  | 'recordings'
  | 'artists'
  | 'artist-credits'
  | 'isrcs'
  | 'url-rels'
  | 'release-groups';

const debug = Debug('musicbrainz-api');

export interface IFormData {
  [key: string]: string | number;
}

export interface IMusicBrainzConfig {
  botAccount?: {
    username: string,
    password: string
  },
  baseUrl: string,

  appName?: string,
  appVersion?: string,

  /**
   * HTTP Proxy
   */
  proxy?: AxiosProxyConfig,

  /**
   * User e-mail address
   */
  appMail?: string
}

export class MusicBrainzApi {

  private static escapeText(text) {
    let str = '';
    for (const chr of text) {
      // Escaping Special Characters: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
      // ToDo: && ||
      switch (chr) {
        case '+':
        case '-':
        case '!':
        case '(':
        case ')':
        case '{':
        case '}':
        case '[':
        case ']':
        case '^':
        case '"':
        case '~':
        case '*':
        case '?':
        case ':':
        case '\\':
        case '/':
          str += '\\';

      }
      str += chr;
    }
    return str;
  }

  private axios: AxiosInstance;

  private config: IMusicBrainzConfig = {
    baseUrl: 'https://musicbrainz.org'
  };

  private rateLimiter: RateLimiter;

  public constructor(config?: IMusicBrainzConfig) {

    Object.assign(this.config, config);

    this.axios = Axios.create({
      baseURL: this.config.baseUrl,
      timeout: 20 * 1000,
      headers: {
        /**
         * https://musicbrainz.org/doc/XML_Web_Service/Rate_Limiting#Provide_meaningful_User-Agent_strings
         */
        'User-Agent': `${this.config.appName}/${this.config.appVersion} ( ${this.config.appMail} )`
      },
      proxy: this.config.proxy
    });

    this.rateLimiter = new RateLimiter(14, 14);

    enableCookies(this.axios);
  }

  public async restGet<T>(relUrl: string, query: { [key: string]: any; } = {}, attempt: number = 1): Promise<T> {

    query.fmt = 'json';

    // await MusicBrainzApi.coolDownTimer.coolDown();
    // const response = await this.axios.get<T>('/ws/2' + relUrl, {params: query});
    let response: AxiosResponse<T>;

    await this.rateLimiter.limit();
    do {
      response = await this.axios.get<T>('/ws/2' + relUrl, {
        params: query,
        validateStatus: status => {
          return status === HttpStatus.OK || status === 503;
        }
      });
      if (response.status !== 503)
        break;
      debug('Rate limiter kicked in, slowing down...');
      await RateLimiter.sleep(500);
    } while (true);

    switch (response.status) {
      case HttpStatus.OK:
        return response.data;

      case HttpStatus.BAD_REQUEST:
      case HttpStatus.NOT_FOUND:
        throw new Error(`Got response status ${response.status}: ${HttpStatus.getStatusText(response.status)}`);

      case HttpStatus.SERVICE_UNAVAILABLE: // 503
      default:
        const msg = `Got response status ${response.status} on attempt #${attempt} (${HttpStatus.getStatusText(response.status)})`;
        debug(msg);
        if (attempt < retries) {
          return this.restGet<T>(relUrl, query, attempt + 1);
        } else
          throw new Error(msg);
    }
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Lookup functions
  // -----------------------------------------------------------------------------------------------------------------

  /**
   * Generic lookup function
   * @param entity
   * @param mbid
   * @param inc
   */
  public getEntity<T>(entity: mb.EntityType, mbid: string, inc: Includes[] = []): Promise<T> {
    return this.restGet<T>(`/${entity}/${mbid}`, {inc: inc.join(' ')});
  }

  /**
   * Lookup area
   * @param areaId Area MBID
   */
  public getArea(areaId: string, inc: Includes[] = []): Promise<mb.IArea> {
    return this.getEntity<mb.IArea>('area', areaId, inc);
  }

  /**
   * Lookup artist
   * @param artistId Artist MBID
   */
  public getArtist(artistId: string, inc: Includes[] = []): Promise<mb.IArtist> {
    return this.getEntity<mb.IArtist>('artist', artistId, inc);
  }

  /**
   * Lookup release
   * @param releaseId Release MBID
   * @param inc Include: artist-credits, labels, recordings, release-groups, media, discids, isrcs (with recordings)
   * ToDo: ['recordings', 'artists', 'artist-credits', 'isrcs', 'url-rels', 'release-groups']
   */
  public getRelease(releaseId: string, inc: Includes[] = []): Promise<mb.IRelease> {
    return this.getEntity<mb.IRelease>('release', releaseId, inc);
  }

  /**
   * Lookup release-group
   * @param releaseGroupId Release-group MBID
   * @param inc Include: ToDo
   */
  public getReleaseGroup(releaseGroupId: string, inc: Includes[] = []): Promise<mb.IReleaseGroup> {
    return this.getEntity<mb.IReleaseGroup>('release-group', releaseGroupId, inc);
  }

  /**
   * Lookup work
   * @param workId Work MBID
   */
  public getWork(workId: string): Promise<mb.IWork> {
    return this.getEntity<mb.IWork>('work', workId);
  }

  /**
   * Lookup label
   * @param labelI Label MBID
   */
  public getLabel(labelId: string): Promise<mb.ILabel> {
    return this.getEntity<mb.ILabel>('label', labelId);
  }

  /**
   * Lookup recording
   * @param recordingId Label MBID
   * @param inc Include: artist-credits, isrcs
   */
  public getRecording(recordingId: string, inc: Array<'artists' | 'artist-credits' | 'releases' | 'isrcs' | 'url-rels'> = []): Promise<mb.IRecording> {
    return this.getEntity<mb.IRecording>('recording', recordingId, inc);
  }

  public async post(entity: mb.EntityType, xmlMetadata: XmlMetadata): Promise<void> {

    const clientId = 'WhatMusic-0.0.4';
    const path = `/ws/2/${entity}/`;
    // Get digest challenge

    const response = await this.axios.post(path, null, {
      params: {client: clientId},
      headers: {
        'Content-Type': 'application/xml'
      },
      validateStatus: status => {
        return status === HttpStatus.UNAUTHORIZED;
      }
    });

    //
    // Post data
    //

    const postData = xmlMetadata.toXml();
    const auth = new DigestAuth(this.config.botAccount);

    const relpath = url.parse(response.request.path).path; // Ensure path is relative
    const digest = auth.digest(response.request.method, relpath, response.headers['www-authenticate']);
    await this.axios.post(`/ws/2/${entity}/`, postData, {
      headers: {
        authorization: digest,
        'Content-Type': 'application/xml'
      },
      params: {client: clientId}
    });
  }

  public async login(): Promise<boolean> {

    const cookies = await getCookies(this.config.baseUrl);

    for (const cookie of cookies) {
      if (cookie.key === 'musicbrainz_server_session')
        return true;
    }

    const formData = querystring.stringify({
      username: this.config.botAccount.username,
      password: this.config.botAccount.password
    });

    const redirectUri = '/success';

    const response = await this.axios.post('/login', formData, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      maxRedirects: 0, // Disable redirects,
      params: {
        uri: redirectUri
      },
      validateStatus: status => {
        return status === HttpStatus.MOVED_TEMPORARILY; // Expect a 302, redirecting to '/success'
      }
    });
    return response.headers.location === redirectUri;
  }

  public async editEntity(entity: mb.EntityType, mbid: string, formData: IFormData): Promise<void> {
    const uri = `/${entity}/${mbid}/edit`;
    await this.axios.post(uri, querystring.stringify(formData), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      maxRedirects: 0, // Disable redirects,
      validateStatus: status => {
        return status === HttpStatus.MOVED_TEMPORARILY; // Expect a 302, redirecting to '/success'
      }
    });
  }

  /**
   * Set URL to recording
   * @param recording Recording to update
   * @param url2add URL to add to the recording
   * @param editNote Edit note
   */
  public async addUrlToRecording(recording: { id: string, title: string }, url2add: { linkTypeId: mb.LinkType, text: string }, editNote: string = '') {

    const formData = {};

    formData[`edit-recording.name`] = recording.title; // Required

    formData[`edit-recording.url.0.link_type_id`] = url2add.linkTypeId;
    formData[`edit-recording.url.0.text`] = url2add.text;

    formData['edit-recording.edit_note'] = editNote;

    return this.editEntity('recording', recording.id, formData);
  }

  /**
   * Add ISRC to recording
   * @param recording Recording to update
   * @param editNote Edit note
   */
  public async addIsrc(recording: { id: string, title: string }, isrc: string, editNote: string = '') {

    const formData = {};

    formData[`edit-recording.name`] = recording.title; // Required
    formData[`edit-recording.isrc.0`] = isrc;

    return this.editEntity('recording', recording.id, formData);
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Query functions
  // -----------------------------------------------------------------------------------------------------------------

  /**
   * Search an entity using a search query
   * @param entity e.g. 'recording'
   * @param query e.g.: '" artist: Madonna, track: Like a virgin"'
   */
  public query<T>(entity: mb.EntityType, query: ISearchQuery): Promise<T> {
    return this.restGet<T>('/' + entity + '/', query);
  }

  // -----------------------------------------------------------------------------------------------------------------
  // Helper functions
  // -----------------------------------------------------------------------------------------------------------------

  /**
   * Add Spotify-ID to MusicBrainz recording.
   * This function will automatically lookup the recording title, which is required to submit the recording URL
   * @param recording MBID of the recording
   * @param spotifyId Spotify ID
   */
  public addSpotifyIdToRecording(recording: { id: string, title: string }, spotifyId: string) {

    assert.strictEqual(spotifyId.length, 22);

    return this.addUrlToRecording(recording, {
      linkTypeId: mb.LinkType.stream_for_free,
      text: 'https://open.spotify.com/track/' + spotifyId
    });
  }

  public searchArtist(name: string, offset?: number, limit?: number): Promise<mb.IArtistList> {
    return this.query<mb.IArtistList>('artist', {query: name, offset, limit});
  }

  public searchReleaseGroup(name: string, offset?: number, limit?: number): Promise<mb.IReleaseGroupList> {
    return this.query<mb.IReleaseGroupList>('release-group', {query: `"${name}"`, offset, limit});
  }

  public searchReleaseGroupByTitleAndArtist(title: string, artist: string, offset?: number, limit?: number): Promise<mb.IReleaseGroupList> {
    const query = '"' + MusicBrainzApi.escapeText(title) + '" AND artist:"' + MusicBrainzApi.escapeText(artist) + '"';
    return this.query<mb.IReleaseGroupList>('release-group', {query, offset, limit});
  }
}
