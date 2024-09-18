import { configDotenv } from 'dotenv';
import got from 'got';
import path from 'path';
import fs from 'fs';
import filenamify from 'filenamify';
import dayjs from 'dayjs';
import { pipeline } from 'stream/promises';
import { EventEmitter } from 'events';

let fetch = got;
let cookie = '';
let uid = '';
let savePath = '';
let downloadConcurrent = 8;
let trackFile = {
    albums: {},
};

class Scheduler {
    concurrent = 8;
    _running = 0;
    _event = new EventEmitter();

    constructor(concurrent) {
        this.concurrent = concurrent;
    }

    async _wait() {
        return new Promise((resolve) => {
            this._event.once('available', () => resolve());
        });
    }

    async run(fn) {
        if (this._running >= this.concurrent) {
            await this._wait();
        }

        this._running++;
        fn().then(() => {
            this._running--;
            this._event.emit('available');
        });
    }
}

function getCookieValue(key) {
    return cookie.split(`${key}=`)?.[1]?.split(';')?.[0];
}

function getGtk(url, skey) {
    var str = skey || getCookieValue('skey') || getCookieValue('rv2') || '',
        hash = 5381;

    if (url) {
        var hostname = new URL(url).hostname;
        if (
            hostname.indexOf('qun.qq.com') > -1 ||
            (hostname.indexOf('qzone.qq.com') > -1 &&
                hostname.indexOf('qun.qzone.qq.com') === -1)
        ) {
            str = getCookieValue('p_skey') || str;
        }
    }

    for (var i = 0, len = str.length; i < len; ++i) {
        hash += (hash << 5) + str.charAt(i).charCodeAt();
    }
    return hash & 0x7fffffff;
}
function checkResp(resp) {
    if (resp.code !== 0) {
        console.error(resp);
        throw new Error(resp.message);
    }
}
function ensureDir(dir) {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, {
            recursive: true,
        });
    }
}

function getTrackFilePath() {
    return path.join(savePath, 'track.json');
}
function loadTrackFile() {
    const trackFilePath = getTrackFilePath();
    if (!fs.existsSync(trackFilePath)) {
        return;
    }
    trackFile = JSON.parse(fs.readFileSync(trackFilePath, 'utf-8'));
}
function saveTrackFile() {
    fs.writeFileSync(getTrackFilePath(), JSON.stringify(trackFile, null, 2));
}

async function getAlbumList(offset = 0, size = 20) {
    const url =
        'https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/fcg_list_album_v3';

    const resp = await fetch
        .get(url, {
            searchParams: {
                handset: 4,
                idcNum: 4,
                source: 'qzone',
                hostUin: uid,
                needUserInfo: 1,
                filter: 1,
                g_tk: getGtk(url),
                pageNumModeClass: 15,
                pageNumModeSort: 40,
                plat: 'qzone',
                inCharset: 'utf-8',
                outCharset: 'utf-8',
                appid: 4,
                uin: uid,
                notice: 0,
                mode: 2,
                sortOrder: 4,
                pageStart: offset,
                pageNum: size,
            },
        })
        .json();
    checkResp(resp);
    return resp.data;
}

async function getAlbumItems(albumId, cursor = null, size = 20) {
    if (!cursor) {
        const url =
            'https://h5.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/cgi_list_photo';
        const resp = await fetch
            .get(url, {
                searchParams: {
                    g_tk: 17137887,
                    mode: 0,
                    idcNum: 4,
                    hostUin: uid,
                    topicId: albumId,
                    noTopic: 0,
                    uin: uid,
                    pageStart: 0,
                    pageNum: 1,
                    skipCmtCount: 0,
                    singleurl: 1,
                    notice: 0,
                    appid: 4,
                    inCharset: 'utf-8',
                    outCharset: 'utf-8',
                    source: 'qzone',
                    plat: 'qzone',
                    outstyle: 'json',
                    format: 'jsonp',
                    json_esc: 1,
                },
            })
            .json();
        checkResp(resp);
        cursor = resp?.data?.photoList?.[0]?.lloc;
    }

    const url =
        'https://user.qzone.qq.com/proxy/domain/photo.qzone.qq.com/fcgi-bin/cgi_floatview_photo_list_v2';
    const resp = await fetch
        .get(url, {
            searchParams: {
                g_tk: getGtk(url),
                topicId: albumId,
                picKey: cursor,
                shootTime: 0,
                cmtOrder: 1,
                fupdate: 1,
                plat: 'qzone',
                source: 'qzone',
                cmtNum: 0,
                likeNum: 0,
                inCharset: 'utf-8',
                outCharset: 'utf-8',
                uin: uid,
                hostUin: uid,
                appid: 4,
                sortOrder: 1,
                showMode: 1,
                need_private_comment: 0,
                prevNum: 0,
                postNum: size,
            },
        })
        .json();
    checkResp(resp);
    return resp.data;
}

async function syncAlbum(album) {
    console.log(`【${album.name}】`);
    const albumTrack = trackFile.albums[album.id] || {
        name: album.name,
        lastUploadTime: -1,
    };

    const albumPath = path.join(savePath, filenamify(albumTrack.name));
    if (albumTrack.name !== album.name) {
        const oldPath = path.join(savePath, filenamify(album.name));

        if (fs.existsSync(oldPath)) {
            fs.renameSync(oldPath, albumPath);
        } else {
            fs.mkdirSync(albumPath);
        }
    }

    ensureDir(albumPath);

    if (album.lastuploadtime <= albumTrack.lastUploadTime) {
        trackFile.albums[album.id] = albumTrack;
        return;
    }

    let cursor = null;
    const scheduler = new Scheduler(downloadConcurrent);
    const currentItemList = fs.readdirSync(albumPath);
    let count = 1;
    albumLoop: while (true) {
        const items = (await getAlbumItems(album.id, cursor, 20)).photos;
        if (!items) break;

        for (const item of items) {
            const itemId = item.lloc;
            if (currentItemList.find((dir) => dir.includes(itemId))) {
                break albumLoop;
            }
            const downloadUrl = item.video_info?.download_url || item.url;

            await scheduler.run(async () => {
                const stream = fetch.stream(downloadUrl);
                const res = await new Promise((resolve) => {
                    stream.on('response', resolve);
                });

                const ext = res.headers['content-type'].split('/')[1] || '';
                const time = item.shootTime
                    ? dayjs.unix(item.shootTime)
                    : dayjs(item.uploadTime);
                const timeString = time.format('YYYY-MM-DD HH-mm-ss');
                const fileName = `${timeString}.${itemId}.${ext}`;
                const filePath = path.join(albumPath, fileName);

                console.log(
                    `[${count++}/${album.total}]`,
                    'Downloading',
                    filePath
                );
                await pipeline([stream, fs.createWriteStream(filePath)]);
            });
        }

        cursor = items.at(-1).lloc;
    }

    albumTrack.lastUploadTime = album.lastuploadtime;
    trackFile.albums[album.id] = albumTrack;
    saveTrackFile();
}

async function syncAlbums() {
    let offset = 0;
    const size = 20;
    while (true) {
        const albumList = (await getAlbumList(offset, size)).albumList;
        if (!albumList) break;

        for (const album of albumList) {
            if (album.name === '2024.8.15.长沙花样汇店') {
                await syncAlbum(album);
                return;
            }
        }

        offset += size;
    }
}

async function main() {
    configDotenv();
    cookie = process.env.QZONE_COOKIE;
    if (!cookie) {
        console.error('QZONE_COOKIE is not defined in environments');
        return;
    }

    uid = getCookieValue('ptui_loginuin');
    if (!uid) {
        console.error('QQ id is not in cookie');
    }

    savePath = process.env.QZONE_SAVE_PATH;
    if (!savePath) {
        console.error('QZONE_SAVE_PATH is not defined in environments');
    }
    savePath = path.join(savePath, uid);
    ensureDir(savePath);

    downloadConcurrent = Number(process.env.QZONE_DOWNLOAD_CONCURRENT || 8);

    loadTrackFile();

    fetch = got.extend({
        headers: {
            Cookie: cookie,
        },
        hooks: {
            afterResponse: [
                (response) => {
                    const match = response.body.match(/^.+\(((?:.|\n)+)\);$/m);
                    if (match) {
                        response.rawBody = Buffer.from(match[1], 'utf-8');
                    }
                    return response;
                },
            ],
        },
        retry: {
            limit: 5,
        },
    });

    await syncAlbums();

    saveTrackFile();
}

main();
