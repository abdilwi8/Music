import 'dotenv/config';
import {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events
} from 'discord.js';
import {
  AudioPlayerStatus,
  NoSubscriberBehavior,
  createAudioPlayer,
  createAudioResource,
  joinVoiceChannel,
  entersState,
  VoiceConnectionStatus
} from '@discordjs/voice';
import play from 'play-dl';

const GUILD_ID = process.env.GUILD_ID || '1492290721691078788';
const VOICE_CHANNEL_IDS = [
  '1517672593627549937',
  '1517672738599338107',
  '1517672843964321822',
  '1538956453669371974',
  '1538956502315049042',
  '1538956539325579485'
];
const PREFIX = process.env.PREFIX || '';
const DEFAULT_VOLUME = Number(process.env.DEFAULT_VOLUME || 100);

async function initializeSoundCloud() {
  const clientId = process.env.SOUNDCLOUD_CLIENT_ID || await play.getFreeClientID();
  await play.setToken({ soundcloud: { client_id: clientId } });
  console.log('[Audio] SoundCloud source initialized.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class MusicRoom {
  constructor(client, roomNumber, voiceChannelId) {
    this.client = client;
    this.roomNumber = roomNumber;
    this.voiceChannelId = voiceChannelId;
    this.queue = [];
    this.current = null;
    this.currentResource = null;
    this.volume = Math.min(130, Math.max(0, DEFAULT_VOLUME));
    this.connection = null;
    this.controlMessage = null;
    this.busy = false;
    this.player = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Play }
    });
    this.player.on(AudioPlayerStatus.Idle, () => this.playNext().catch((error) => this.report(error)));
    this.player.on('error', (error) => this.report(error));
  }

  async start() {
    const guild = await this.client.guilds.fetch(GUILD_ID);
    const channel = await guild.channels.fetch(this.voiceChannelId);
    if (!channel || !channel.isVoiceBased()) throw new Error(`Voice channel not found: ${this.voiceChannelId}`);

    this.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: true,
      selfMute: false
    });
    this.connection.subscribe(this.player);
    await entersState(this.connection, VoiceConnectionStatus.Ready, 30_000);
    console.log(`[Bot ${this.roomNumber}] connected to ${channel.name}`);
  }

  async handleMessage(message) {
    if (!message.guild || message.guild.id !== GUILD_ID || message.author.bot) return;
    const content = message.content.trim();
    if (!content) return;

    const [rawCommand, ...args] = content.split(/\s+/);
    const command = rawCommand.replace(PREFIX, '');

    if (command === 'ش') {
      const query = args.join(' ');
      if (!query) return message.reply('اكتب اسم الأغنية بعد الأمر، مثال: `ش راب عربي`');
      return this.enqueue(message, query);
    }
    if (command === 'وقف') {
      this.player.pause(true);
      return message.reply('⏸️ تم إيقاف الأغنية مؤقتًا. للتشغيل اكتب `كمل`.');
    }
    if (command === 'كمل') {
      this.player.unpause();
      return message.reply('▶️ تم استئناف التشغيل.');
    }
    if (command === 'س') {
      this.player.stop();
      return message.reply('⏭️ تم تخطي الأغنية.');
    }
    if (command === 'صوت') {
      const amount = Number(args[0]);
      if (!Number.isFinite(amount)) return message.reply('اكتب مستوى الصوت، مثال: `صوت 100`');
      this.volume = Math.min(130, Math.max(0, amount));
      if (this.currentResource?.volume) this.currentResource.volume.setVolume(this.volume / 100);
      return message.reply(`🔊 تم ضبط الصوت على **${this.volume}%**.`);
    }
    if (command === 'قدم') {
      const seconds = Number(args[0]);
      if (!Number.isFinite(seconds) || seconds < 0) return message.reply('اكتب عدد الثواني، مثال: `قدم 20`');
      return this.seek(seconds, message);
    }
    if (command === 'قائمة') return message.reply(this.queueText());
    if (command === 'انهاء' || command === 'خروج') {
      this.queue = [];
      this.current = null;
      this.player.stop(true);
      return message.reply('⏹️ تم إنهاء التشغيل وتفريغ القائمة.');
    }
  }

  async enqueue(message, query) {
    if (this.busy) return message.reply('⏳ لحظة، أبحث عن الأغنية الحالية.');
    this.busy = true;
    try {
      // YouTube is intentionally not used here because the hosting server is
      // being rejected by YouTube's automated bot check. Search SoundCloud
      // instead; direct SoundCloud track URLs are supported as well.
      let track;
      const isSoundCloudUrl = /^https?:\/\/(www\.)?soundcloud\.com\//i.test(query);
      if (isSoundCloudUrl) {
        track = await play.soundcloud(query);
      } else if (/^https?:\/\//i.test(query)) {
        return message.reply('❌ استخدم رابط SoundCloud أو اكتب اسم الأغنية للبحث.');
      } else {
        const results = await play.search(query, { limit: 1, source: { soundcloud: 'tracks' } });
        track = results[0];
      }

      if (!track?.url && !track?.permalink) {
        return message.reply('❌ لم أجد الأغنية في SoundCloud. جرّب اسمًا آخر أو رابط SoundCloud مباشر.');
      }
      const item = {
        title: track.name || 'أغنية بدون عنوان',
        url: track.permalink || track.url,
        thumbnail: track.thumbnail || null,
        duration: track.durationInSec || 0,
        durationText: track.durationInSec ? formatSeconds(track.durationInSec) : 'غير معروف',
        requestedBy: message.author.tag,
        seek: 0
      };
      this.queue.push(item);
      await message.reply(`✅ تمت إضافة **${item.title}** من SoundCloud إلى قائمة التشغيل.`);
      if (!this.current) await this.playNext();
    } catch (error) {
      this.report(error);
      await message.reply('❌ تعذر جلب الصوت من SoundCloud. جرّب اسمًا آخر أو رابطًا مباشر.');
    } finally {
      this.busy = false;
    }
  }

  async playNext() {
    const next = this.queue.shift();
    if (!next) {
      this.current = null;
      this.currentResource = null;
      return;
    }
    this.current = next;
    try {
      const source = await play.stream(next.url, { seek: next.seek || 0 });
      this.currentResource = createAudioResource(source.stream, {
        inputType: source.type,
        inlineVolume: true,
        metadata: next
      });
      this.currentResource.volume.setVolume(this.volume / 100);
      this.current.startedAt = Date.now();
      this.player.play(this.currentResource);
      await this.publishNowPlaying();
    } catch (error) {
      this.report(error);
      this.current = null;
      await this.playNext();
    }
  }

  async seek(seconds, message) {
    if (!this.current) return message.reply('لا توجد أغنية تعمل الآن.');
    if (this.current.duration && seconds >= this.current.duration) {
      return message.reply('❌ لا يمكن التقديم بعد نهاية الأغنية.');
    }
    const track = { ...this.current, seek: seconds };
    this.current = null;
    this.queue.unshift(track);
    this.player.stop();
    await message.reply(`⏩ تم التقديم إلى **${seconds} ثانية**.`);
  }

  queueText() {
    if (!this.current && this.queue.length === 0) return '📭 قائمة التشغيل فارغة.';
    const currentLine = this.current ? `▶️ الآن: **${this.current.title}**` : 'لا توجد أغنية تعمل.';
    const nextLines = this.queue.slice(0, 10).map((item, index) => `${index + 1}. ${item.title}`);
    return [currentLine, nextLines.length ? `\nالقادم:\n${nextLines.join('\n')}` : ''].join('');
  }

  progressBar() {
    if (!this.current?.duration) return '🔴 LIVE';
    const elapsed = Math.min(this.current.duration, Math.max(0, (Date.now() - this.current.startedAt) / 1000 + (this.current.seek || 0)));
    const width = 18;
    const filled = Math.round((elapsed / this.current.duration) * width);
    return `${'▬'.repeat(Math.max(0, filled))}🔘${'▬'.repeat(Math.max(0, width - filled))} ${formatSeconds(elapsed)} / ${formatSeconds(this.current.duration)}`;
  }

  async publishNowPlaying() {
    const channel = this.client.channels.cache.find((c) => c.isTextBased() && c.name?.toLowerCase().includes('music'))
      || this.client.channels.cache.find((c) => c.isTextBased() && c.guild?.id === GUILD_ID);
    if (!channel || !this.current) return;
    const embed = this.makeEmbed();
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('music_pause').setLabel('إيقاف مؤقت').setEmoji('⏸️').setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('music_resume').setLabel('تشغيل').setEmoji('▶️').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('music_skip').setLabel('تخطي').setEmoji('⏭️').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('music_stop').setLabel('إنهاء').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
    );
    if (this.controlMessage) {
      try { await this.controlMessage.edit({ embeds: [embed], components: [row] }); return; } catch { this.controlMessage = null; }
    }
    this.controlMessage = await channel.send({ embeds: [embed], components: [row] });
  }

  makeEmbed() {
    const embed = new EmbedBuilder()
      .setColor(0x7c3aed)
      .setTitle('🎵 التشغيل الآن')
      .setDescription(`**${this.current.title}**\n\n${this.progressBar()}\n\n🔊 الصوت: **${this.volume}%**\n📡 البوت: **${this.roomNumber}**\n👤 طلبها: **${this.current.requestedBy}**`)
      .setFooter({ text: 'الأوامر: ش | وقف | كمل | س | صوت 100 | قدم 20 | قائمة' })
      .setTimestamp();
    if (this.current.thumbnail) embed.setThumbnail(this.current.thumbnail);
    return embed;
  }

  report(error) {
    console.error(`[Bot ${this.roomNumber}]`, error?.message || error);
  }
}

function formatSeconds(value) {
  const total = Math.max(0, Math.floor(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function tokenFor(index) {
  return process.env[`BOT_${index}_TOKEN`];
}

for (let i = 0; i < 6; i += 1) {
  const token = tokenFor(i + 1);
  if (!token) {
    console.warn(`[Bot ${i + 1}] missing BOT_${i + 1}_TOKEN; skipped until .env is filled.`);
    continue;
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildVoiceStates
    ]
  });
  const room = new MusicRoom(client, i + 1, VOICE_CHANNEL_IDS[i]);
  client.once(Events.ClientReady, async (readyClient) => {
    console.log(`[Bot ${i + 1}] logged in as ${readyClient.user.tag}`);
    try {
      await initializeSoundCloud();
      await room.start();
    } catch (error) { room.report(error); }
  });
  client.on(Events.MessageCreate, (message) => room.handleMessage(message).catch((error) => room.report(error)));
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    try {
      if (interaction.customId === 'music_pause') room.player.pause(true);
      if (interaction.customId === 'music_resume') room.player.unpause();
      if (interaction.customId === 'music_skip') room.player.stop();
      if (interaction.customId === 'music_stop') { room.queue = []; room.current = null; room.player.stop(true); }
      await interaction.reply({ content: 'تم تنفيذ الأمر.', ephemeral: true });
    } catch (error) { room.report(error); }
  });
  client.login(token).catch((error) => room.report(error));
}
