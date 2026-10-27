//! Spike: verify songbird voice receive (transport + DAVE decrypt, Opus decode)
//! delivers 24 kHz mono i16 PCM per speaker, ahead of the full migration.
//!
//! Env: `SPIKE_DISCORD_TOKEN`, `SPIKE_GUILD_ID`, `SPIKE_VOICE_CHANNEL_ID`,
//! optional `SPIKE_SECONDS` (default 120).
//! Output: `spike-out/{userId}.pcm` (24 kHz mono s16le) and one stats line per
//! speaker: `user=<id> first_packet_ms=<n> samples=<n> max_gap_ms=<n> plc_ticks=<n> max_samples_per_tick=<n>`.

use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    os::unix::fs::FileExt,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

use serenity::{
    async_trait,
    model::{
        gateway::{GatewayIntents, Ready},
        id::{ChannelId, GuildId},
    },
    prelude::Context,
};
use songbird::{
    Config,
    driver::{Channels, DecodeConfig, DecodeMode, SampleRate},
    events::{CoreEvent, Event, EventContext, EventHandler as SongbirdEventHandler},
};
use tokio::sync::Mutex;

use serenity::client::EventHandler as SerenityEventHandler;

/// Received audio is decoded to 24 kHz mono, i.e. 24 samples per millisecond.
const SAMPLES_PER_MS: u64 = 24;

// --- pure timeline logic (unit-tested below) ---

/// Place the write cursor before appending a received packet: never move
/// backwards, and after any interruption snap forward to the wall-clock
/// sample position so gaps stay in the timeline (like `TrackWriter`).
fn place_cursor(cursor: u64, elapsed_ms: u64) -> u64 {
    cursor.max(elapsed_ms * SAMPLES_PER_MS)
}

/// Update the running maximum gap (ms) between consecutive packets and the
/// last-seen packet time. The first packet has no gap; late timestamps
/// never underflow.
fn update_gap(max_gap_ms: u64, last_packet_ms: Option<u64>, now_ms: u64) -> (u64, u64) {
    let gap_ms = last_packet_ms.map_or(0, |prev| now_ms.saturating_sub(prev));
    (max_gap_ms.max(gap_ms), now_ms)
}

/// Only a tick carrying a real RTP packet advances the timeline; a
/// lost-packet concealment tick (`packet: None`) leaves the cursor where it
/// was, no matter how many decoded samples it carries.
fn advance_cursor(cursor: u64, packet_present: bool, decoded_samples: usize) -> u64 {
    if packet_present {
        cursor + decoded_samples as u64
    } else {
        cursor
    }
}

// --- receive state ---

struct UserOut {
    file: File,
    /// Next sample position to write at (24 kHz samples, not bytes).
    cursor: u64,
    samples: u64,
    first_packet_ms: Option<u64>,
    last_packet_ms: Option<u64>,
    max_gap_ms: u64,
    /// Ticks where this user was scheduled but the RTP packet was lost.
    plc_ticks: u64,
    max_samples_per_tick: usize,
}

impl UserOut {
    fn open(user_id: u64) -> Self {
        let file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(format!("spike-out/{user_id}.pcm"))
            .expect("create per-user pcm file");
        Self {
            file,
            cursor: 0,
            samples: 0,
            first_packet_ms: None,
            last_packet_ms: None,
            max_gap_ms: 0,
            plc_ticks: 0,
            max_samples_per_tick: 0,
        }
    }
}

struct Rx {
    start: Instant,
    ssrc_to_user: Mutex<HashMap<u32, u64>>,
    out: Mutex<HashMap<u64, UserOut>>,
}

impl Rx {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            ssrc_to_user: Mutex::new(HashMap::new()),
            out: Mutex::new(HashMap::new()),
        }
    }
}

/// `EventData::new` takes its handler by value and stores one copy per
/// registered event, so share the state through an `Arc` wrapper.
struct RxHandle(Arc<Rx>);

#[async_trait]
impl SongbirdEventHandler for RxHandle {
    async fn act(&self, ctx: &EventContext<'_>) -> Option<Event> {
        match ctx {
            EventContext::SpeakingStateUpdate(s) => {
                if let Some(user_id) = s.user_id {
                    self.0.ssrc_to_user.lock().await.insert(s.ssrc, user_id.0);
                }
            }
            EventContext::VoiceTick(t) => {
                let now_ms = self.0.start.elapsed().as_millis() as u64;
                let mut out = self.0.out.lock().await;
                let ssrcs = self.0.ssrc_to_user.lock().await;
                for (ssrc, data) in &t.speaking {
                    let Some(&user_id) = ssrcs.get(ssrc) else {
                        continue;
                    };
                    let entry = out.entry(user_id).or_insert_with(|| UserOut::open(user_id));

                    if data.packet.is_some() {
                        let Some(pcm) = &data.decoded_voice else {
                            continue;
                        };
                        let (max_gap_ms, last_packet_ms) =
                            update_gap(entry.max_gap_ms, entry.last_packet_ms, now_ms);
                        entry.max_gap_ms = max_gap_ms;
                        entry.last_packet_ms = Some(last_packet_ms);
                        if entry.first_packet_ms.is_none() {
                            entry.first_packet_ms = Some(now_ms);
                        }
                        let cursor = place_cursor(entry.cursor, now_ms);
                        let bytes: Vec<u8> = pcm.iter().flat_map(|s| s.to_le_bytes()).collect();
                        entry
                            .file
                            .write_all_at(&bytes, cursor * 2)
                            .expect("write pcm");
                        entry.cursor = advance_cursor(cursor, true, pcm.len());
                        entry.samples += pcm.len() as u64;
                        entry.max_samples_per_tick = entry.max_samples_per_tick.max(pcm.len());
                    } else {
                        // Lost packet: songbird hands out a concealment frame
                        // (~80 ms at mono 24 kHz). Count it, never write it.
                        entry.plc_ticks += 1;
                    }
                }
            }
            _ => {}
        }
        None
    }
}

struct Handler {
    guild_id: GuildId,
    channel_id: ChannelId,
    rx: Arc<Rx>,
    joined: AtomicBool,
}

#[async_trait]
impl SerenityEventHandler for Handler {
    async fn ready(&self, ctx: Context, _ready: Ready) {
        if self.joined.swap(true, Ordering::SeqCst) {
            return;
        }
        let manager = songbird::get(&ctx)
            .await
            .expect("Songbird voice client registered at startup");
        let call = manager
            .join(self.guild_id, self.channel_id)
            .await
            .expect("voice channel join failed");
        let mut call = call.lock().await;
        call.deafen(false)
            .await
            .expect("failed to join without deafening");
        call.add_global_event(CoreEvent::VoiceTick.into(), RxHandle(self.rx.clone()));
        call.add_global_event(
            CoreEvent::SpeakingStateUpdate.into(),
            RxHandle(self.rx.clone()),
        );
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let token = std::env::var("SPIKE_DISCORD_TOKEN").expect("SPIKE_DISCORD_TOKEN not set");
    let guild_id = GuildId::new(
        std::env::var("SPIKE_GUILD_ID")
            .expect("SPIKE_GUILD_ID not set")
            .parse()?,
    );
    let channel_id = ChannelId::new(
        std::env::var("SPIKE_VOICE_CHANNEL_ID")
            .expect("SPIKE_VOICE_CHANNEL_ID not set")
            .parse()?,
    );
    let seconds: u64 = std::env::var("SPIKE_SECONDS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);

    fs::create_dir_all("spike-out")?;

    let rx = Arc::new(Rx::new());
    let mut client = songbird::register_from_config(
        serenity::Client::builder(
            &token,
            GatewayIntents::GUILDS | GatewayIntents::GUILD_VOICE_STATES,
        )
        .event_handler(Handler {
            guild_id,
            channel_id,
            rx: rx.clone(),
            joined: AtomicBool::new(false),
        }),
        Config::default().decode_mode(DecodeMode::Decode(DecodeConfig::new(
            Channels::Mono,
            SampleRate::Hz24000,
        ))),
    )
    .await?;

    let shard_manager = client.shard_manager.clone();
    tokio::spawn(async move {
        if let Err(e) = client.start().await {
            tracing::error!("gateway client error: {e:?}");
        }
    });

    tokio::time::sleep(Duration::from_secs(seconds)).await;
    shard_manager.shutdown_all().await;

    let out = rx.out.lock().await;
    let mut users: Vec<_> = out.iter().collect();
    users.sort_by_key(|(id, _)| *id);
    for (user_id, o) in users {
        let _ = o.file.sync_all();
        println!(
            "user={user_id} first_packet_ms={} samples={} max_gap_ms={} plc_ticks={} max_samples_per_tick={}",
            o.first_packet_ms.unwrap_or(0),
            o.samples,
            o.max_gap_ms,
            o.plc_ticks,
            o.max_samples_per_tick,
        );
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cursor_is_max_of_stored_position_and_wall_clock() {
        // Continuous speech: the received-sample cursor stays ahead of wall clock.
        assert_eq!(place_cursor(1_000, 40), 1_000); // 40 ms = 960 samples < 1000
        // After silence the cursor snaps forward to the wall-clock position.
        assert_eq!(place_cursor(1_000, 100), 2_400); // 100 ms = 2400 samples
    }

    #[test]
    fn gap_math_tracks_max_and_updates_last_seen() {
        // First packet: no gap.
        assert_eq!(update_gap(0, None, 500), (0, 500));
        // 200 ms since the last packet raises the max.
        assert_eq!(update_gap(0, Some(500), 700), (200, 700));
        // A shorter gap never lowers the max; late timestamps never underflow.
        assert_eq!(update_gap(400, Some(700), 500), (400, 500));
    }

    #[test]
    fn lost_packet_tick_never_moves_the_cursor() {
        // A scripted tick with packet: None and 1920 decoded (concealment)
        // samples must not advance the timeline.
        let cursor = 48_000;
        assert_eq!(advance_cursor(cursor, false, 1920), cursor);
        // A real packet advances it by exactly the decoded sample count.
        assert_eq!(advance_cursor(cursor, true, 1_920), 49_920);
    }
}
