import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const inputPath = process.argv[2] || path.join(__dirname, "likelist_raw.json");
const outputPath = process.argv[3] || path.join(__dirname, "likelist.json");

const raw = JSON.parse(fs.readFileSync(inputPath, "utf8"));

if (!Array.isArray(raw.songs)) {
  throw new Error("Expected raw.songs to be an array");
}

const privileges = new Map(
  Array.isArray(raw.privileges) ? raw.privileges.map((item) => [item.id, item]) : [],
);

function compact(value) {
  if (Array.isArray(value)) {
    return value.map(compact).filter((item) => item !== null && item !== undefined);
  }

  if (!value || typeof value !== "object") {
    return value === undefined ? null : value;
  }

  return Object.fromEntries(
    Object.entries(value)
      .map(([key, item]) => [key, compact(item)])
      .filter(([, item]) => {
        if (item === null || item === undefined) return false;
        if (Array.isArray(item) && item.length === 0) return false;
        if (typeof item === "object" && Object.keys(item).length === 0) return false;
        return true;
      }),
  );
}

function toIsoDate(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  return new Date(timestamp).toISOString().slice(0, 10);
}

function normalizeArtist(artist) {
  return compact({
    id: artist.id,
    name: artist.name,
    aliases: artist.alias,
    translated_names: artist.tns,
  });
}

function normalizeAlbum(album) {
  if (!album) return null;
  return compact({
    id: album.id,
    name: album.name,
    translated_names: album.tns,
    cover_url: album.picUrl,
    cover_id: album.pic_str || (album.pic ? String(album.pic) : null),
  });
}

function normalizeQuality(song) {
  return compact({
    hr_bitrate: song.hr?.br,
    sq_bitrate: song.sq?.br,
    high_bitrate: song.h?.br,
    medium_bitrate: song.m?.br,
    low_bitrate: song.l?.br,
  });
}

function normalizePrivilege(privilege) {
  if (!privilege) return null;

  return compact({
    fee: privilege.fee,
    status: privilege.st,
    playable: privilege.st === 0 && privilege.pl > 0,
    play_bitrate: privilege.pl,
    download_bitrate: privilege.dl,
    max_bitrate: privilege.maxbr,
    play_level: privilege.plLevel,
    download_level: privilege.dlLevel,
    max_level: privilege.maxBrLevel,
    free_trial: privilege.freeTrialPrivilege
      ? {
          resource_consumable: privilege.freeTrialPrivilege.resConsumable,
          user_consumable: privilege.freeTrialPrivilege.userConsumable,
          cannot_listen_reason: privilege.freeTrialPrivilege.cannotListenReason,
        }
      : null,
  });
}

function normalizeTags(song) {
  return compact({
    display: song.displayTags,
    entertainment: song.entertainmentTags,
    award: song.awardTags,
    mark: song.markTags,
    feature: song.songFeature,
  });
}

function normalizeSong(song, index) {
  const artists = Array.isArray(song.ar) ? song.ar.map(normalizeArtist) : [];
  const aliases = Array.isArray(song.alia) ? song.alia : [];
  const titleParts = [song.name, ...aliases, ...artists.map((artist) => artist.name)].filter(Boolean);

  return compact({
    index,
    id: song.id,
    name: song.name,
    main_title: song.mainTitle,
    additional_title: song.additionalTitle,
    aliases,
    artists,
    artist_names: artists.map((artist) => artist.name),
    album: normalizeAlbum(song.al),
    duration_ms: song.dt,
    duration_sec: Number.isFinite(song.dt) ? Math.round(song.dt / 1000) : null,
    popularity: song.pop,
    fee: song.fee,
    mv_id: song.mv || null,
    cd: song.cd,
    track_no: song.no,
    copyright: song.copyright,
    status: song.st,
    resource_state: song.resourceState,
    publish_time_ms: song.publishTime || null,
    publish_date: toIsoDate(song.publishTime),
    quality: normalizeQuality(song),
    privilege: normalizePrivilege(privileges.get(song.id)),
    tags: normalizeTags(song),
    origin_song: song.originSongSimpleData
      ? {
          id: song.originSongSimpleData.songId,
          name: song.originSongSimpleData.name,
          artists: song.originSongSimpleData.artists?.map(normalizeArtist),
          album: normalizeAlbum(song.originSongSimpleData.albumMeta),
        }
      : null,
    search_text: titleParts.join(" - "),
  });
}

const normalized = {
  meta: {
    source_file: path.relative(process.cwd(), inputPath),
    generated_at: new Date().toISOString(),
    raw_code: raw.code,
    song_count: raw.songs.length,
  },
  songs: raw.songs.map(normalizeSong),
};

fs.writeFileSync(outputPath, `${JSON.stringify(normalized, null, 2)}\n`);

console.log(`Normalized ${normalized.songs.length} songs -> ${path.relative(process.cwd(), outputPath)}`);
