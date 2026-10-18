// بوت مسابقة الصور - discord.js v14 (Node 18+)
// التشغيل: npm install ثم npm start (التوكن في ملف .env)

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  PermissionsBitField,
  AttachmentBuilder,
  ChannelType,
  EmbedBuilder,
} = require('discord.js');
const fs = require('fs');
const path = require('path');

const PREFIX = '!';
const STAR = '⭐';
const MEDALS = ['🥇', '🥈', '🥉'];
const RANKS = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
const COLOR = 0xf1c40f;
const DATA_FILE = path.join(__dirname, 'data.json');
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const ALLOWED_EXT = /\.(png|jpe?g|webp)$/i;
const WARN_SECONDS = 6;
const TOP_LIMIT = 10;
const DAY_MS = 24 * 60 * 60 * 1000;
const EDIT_GAP_MS = 1200; // فاصل بين تعديلات الرسائل عشان ما نضغط على ديسكورد
const SWEEP_EVERY_MS = 10 * 60 * 1000; // إعادة حساب شاملة كل 10 دقايق

if (!process.env.TOKEN) {
  console.error('❌ ما لقيت TOKEN. افتح ملف .env وحط توكن البوت.');
  process.exit(1);
}

// ---------- التخزين المحلي ----------
let data = {};
try {
  data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
} catch {
  data = {};
}

function save() {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DATA_FILE); // كتابة آمنة عشان الملف ما يخرب
}

function getConf(guildId) {
  const conf = data[guildId];
  if (conf) {
    conf.entries ||= {}; // userId -> { number, messageId, username, votes, shown }
    conf.count ||= 0;
    conf.allowSelfVote ??= false;
    conf.minAccountDays ??= 7; // الحسابات الأحدث من كذا ما تحسب أصواتها
    conf.winners ??= 3; // عدد الفايزين
    conf.ended ??= false; // المسابقة منتهية والتصويت مقفل
  }
  return conf;
}

// ---------- البوت ----------
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers, // لمعرفة اللي يطلع من السيرفر
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

const busyUsers = new Set(); // يمنع إرسال صورتين بنفس اللحظة
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- أدوات مساعدة ----------
async function warn(channel, userId, text) {
  const msg = await channel
    .send({
      content: `<@${userId}> ${text}`,
      allowedMentions: { users: [userId] },
    })
    .catch(() => null);
  if (msg) setTimeout(() => msg.delete().catch(() => {}), WARN_SECONDS * 1000);
}

function checkSubmission(message) {
  if (message.content.trim() !== '') return 'ممنوع الكلام أو الروابط، صورة فقط.';
  if (message.stickers.size > 0) return 'ممنوع الملصقات.';
  if (message.attachments.size !== 1) return 'ارسل صورة وحدة فقط.';

  const file = message.attachments.first();
  const type = (file.contentType || '').split(';')[0].toLowerCase();
  if (!ALLOWED_TYPES.includes(type) || !ALLOWED_EXT.test(file.name || '')) {
    return 'مسموح صور ثابتة فقط (png / jpg / webp)، ممنوع المتحركة والفيديو.';
  }
  return null;
}

function missingPermissions(channel, flags) {
  const perms = channel.permissionsFor(channel.guild.members.me);
  const missing = flags.filter((f) => !perms?.has(f));
  return new PermissionsBitField(missing).toArray();
}

function findOwner(conf, messageId) {
  return Object.keys(conf.entries).find((k) => conf.entries[k].messageId === messageId);
}

// هل الشخص داخل السيرفر؟
async function isMember(guild, userId) {
  if (guild.members.cache.has(userId)) return true;
  try {
    await guild.members.fetch(userId);
    return true;
  } catch (err) {
    return err.code === 10007 || err.code === 10013 ? false : true; // خطأ ثاني: نفترض موجود
  }
}

// ---------- حساب الأصوات الصالحة ----------
async function fetchAllReactionUsers(reaction) {
  const all = [];
  let after;
  while (true) {
    const batch = await reaction.users.fetch({ limit: 100, after });
    if (!batch.size) break;
    all.push(...batch.values());
    if (batch.size < 100) break;
    after = batch.last().id;
  }
  return all;
}

// الصوت الصالح: مو بوت، مو صاحب الصورة (إذا ممنوع)، داخل السيرفر، وعمر حسابه كافي
async function countValidVotes(guild, conf, msg, ownerId) {
  const reaction = msg.reactions.cache.find((r) => r.emoji.name === STAR);
  if (!reaction) return 0;

  const users = await fetchAllReactionUsers(reaction);
  const minAge = conf.minAccountDays * DAY_MS;
  const now = Date.now();
  let valid = 0;

  for (const u of users) {
    if (u.bot) continue; // رياكشن البوت نفسه وأي بوت ما ينحسب
    if (!conf.allowSelfVote && u.id === ownerId) continue;
    if (minAge > 0 && now - u.createdTimestamp < minAge) continue; // حساب جديد
    if (!(await isMember(guild, u.id))) continue; // طلع من السيرفر
    valid += 1;
  }
  return valid;
}

function buildContent(entry, userId, votes) {
  const name = entry.username ? ` (${entry.username})` : '';
  return (
    `🏆 **المتسابق رقم ${entry.number}**\n` +
    `👤 <@${userId}>${name}\n` +
    `${STAR} الأصوات الصالحة: **${votes}**`
  );
}

// يحسب أصوات مشاركة وحدة ويحدّث الرسالة إذا تغير العدد
async function refreshEntry(guild, conf, userId, channel) {
  const entry = conf.entries[userId];
  if (!entry?.messageId) return null;

  channel ||= await guild.channels.fetch(conf.voteChannel).catch(() => null);
  const msg = await channel?.messages.fetch(entry.messageId).catch(() => null);
  if (!msg) return null;

  const votes = await countValidVotes(guild, conf, msg, userId);
  entry.votes = votes;

  if (entry.shown !== votes) {
    await msg.edit({
      content: buildContent(entry, userId, votes),
      allowedMentions: { parse: [] },
    });
    entry.shown = votes;
    save();
  }
  return votes;
}

// حساب شامل لكل المشاركات (يستبعد اللي طلعوا من السيرفر) مرتب من الأعلى
async function recountAll(guild, conf) {
  const channel = await guild.channels.fetch(conf.voteChannel).catch(() => null);
  const results = [];

  for (const [userId, entry] of Object.entries(conf.entries)) {
    if (!entry.messageId) continue;
    if (!(await isMember(guild, userId))) continue; // المتسابق طلع -> يتصفى
    try {
      const votes = await refreshEntry(guild, conf, userId, channel);
      if (votes === null) continue;
      results.push({ userId, number: entry.number, votes });
    } catch (err) {
      console.error(`فشل حساب المشاركة ${entry.number}:`, err.message);
    }
  }

  save();
  // عند التعادل الأسبق مشاركة يتقدم
  return results.sort((a, b) => b.votes - a.votes || a.number - b.number);
}

// ---------- طابور التحديث (يمنع الضغط على ديسكورد) ----------
const pending = new Map(); // "guildId:userId" -> job
let queueRunning = false;

function scheduleRefresh(guildId, userId) {
  pending.set(`${guildId}:${userId}`, { guildId, userId });
  runQueue();
}

async function runQueue() {
  if (queueRunning) return;
  queueRunning = true;
  try {
    while (pending.size) {
      const [key, job] = pending.entries().next().value;
      pending.delete(key);
      const guild = client.guilds.cache.get(job.guildId);
      const conf = getConf(job.guildId);
      if (guild && conf) {
        try {
          await refreshEntry(guild, conf, job.userId);
        } catch (err) {
          console.error('فشل تحديث الأصوات:', err.message);
        }
      }
      await sleep(EDIT_GAP_MS);
    }
  } finally {
    queueRunning = false;
  }
}

function scheduleAll(guildId) {
  const conf = getConf(guildId);
  if (!conf) return;
  for (const userId of Object.keys(conf.entries)) scheduleRefresh(guildId, userId);
}

const sweepTimers = new Map();
function scheduleAllDebounced(guildId) {
  if (sweepTimers.has(guildId)) return;
  sweepTimers.set(
    guildId,
    setTimeout(() => {
      sweepTimers.delete(guildId);
      scheduleAll(guildId);
    }, 20_000)
  );
}

// ---------- إعلان الفائزين ----------
function buildResultsEmbed(scores, conf, { final }) {
  const n = conf.winners;
  const embed = new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(final ? '🏆 نتيجة المسابقة' : `🏅 أعلى ${Math.min(TOP_LIMIT, scores.length)} متسابقين`)
    .setTimestamp();

  if (!scores.length || scores[0].votes === 0) {
    return embed.setDescription('ما فيه أصوات صالحة للحين.');
  }

  const list = final ? scores.slice(0, n).filter((s) => s.votes > 0) : scores.slice(0, TOP_LIMIT);
  const lines = list.map(
    (s, i) =>
      `${MEDALS[i] || '🏅'} **المركز ${RANKS[i] || i + 1}** — المتسابق رقم **${s.number}** — <@${s.userId}> — **${s.votes}** ${STAR}`
  );
  let desc = lines.join('\n');

  // تنبيه إذا فيه تعادل على آخر مركز فايز
  if (final && scores.length > n && scores[n].votes === scores[n - 1].votes && scores[n - 1].votes > 0) {
    const tied = scores.filter((s) => s.votes === scores[n - 1].votes).map((s) => `#${s.number}`);
    desc += `\n\n⚠️ فيه تعادل على آخر مركز (${scores[n - 1].votes} صوت) بين: ${tied.join(' ، ')}.\nتم الترتيب بحسب أسبق مشاركة.`;
  }
  desc += `\n\n_تُحسب الأصوات الصالحة فقط._`;
  return embed.setDescription(desc);
}

// ---------- الأوامر ----------
async function handleCommand(message, cmd, args) {
  const guild = message.guild;
  const conf = getConf(guild.id);

  if (cmd === 'setup') {
    const ids = [...message.content.matchAll(/<#(\d+)>/g)].map((m) => m[1]);
    if (ids.length < 2) {
      return message.reply('الاستخدام: `!setup #روم-الصور #روم-التصويت`');
    }
    if (ids[0] === ids[1]) {
      return message.reply('❌ لازم روم الصور غير روم التصويت.');
    }

    const photoCh = guild.channels.cache.get(ids[0]);
    const voteCh = guild.channels.cache.get(ids[1]);
    if (photoCh?.type !== ChannelType.GuildText || voteCh?.type !== ChannelType.GuildText) {
      return message.reply('❌ لازم الاثنين رومات كتابية عادية.');
    }

    const F = PermissionsBitField.Flags;
    const miss1 = missingPermissions(photoCh, [F.ViewChannel, F.ManageMessages, F.SendMessages]);
    const miss2 = missingPermissions(voteCh, [
      F.ViewChannel,
      F.SendMessages,
      F.AttachFiles,
      F.AddReactions,
      F.ReadMessageHistory,
      F.ManageMessages,
    ]);
    if (miss1.length || miss2.length) {
      return message.reply(
        '❌ ينقص البوت صلاحيات:\n' +
          (miss1.length ? `<#${ids[0]}>: ${miss1.join(', ')}\n` : '') +
          (miss2.length ? `<#${ids[1]}>: ${miss2.join(', ')}` : '')
      );
    }

    data[guild.id] = {
      submitChannel: ids[0],
      voteChannel: ids[1],
      active: true,
      ended: false,
      count: conf?.count || 0,
      entries: conf?.entries || {},
      allowSelfVote: conf?.allowSelfVote ?? false,
      minAccountDays: conf?.minAccountDays ?? 7,
      winners: conf?.winners ?? 3,
    };
    save();
    return message.reply(
      `✅ تم الإعداد\n📸 روم الصور: <#${ids[0]}>\n🗳️ روم التصويت: <#${ids[1]}>\nالمسابقة شغالة.`
    );
  }

  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('أوامر بوت المسابقة (للإدارة)')
      .setDescription(
        [
          '`!setup #الصور #التصويت` إعداد وتشغيل',
          '`!stop` إيقاف استقبال الصور',
          '`!resume` تشغيل المسابقة من جديد',
          '`!end` إنهاء المسابقة وإعلان الفايزين وقفل التصويت',
          '`!top` ترتيب أعلى المتسابقين (أصوات صالحة)',
          '`!status` حالة المسابقة',
          '`!winners رقم` عدد الفايزين (الافتراضي 3)',
          '`!minage أيام` أقل عمر حساب للتصويت (الافتراضي 7، و0 يعطّله)',
          '`!selfvote on/off` السماح بالتصويت لنفسه',
          '`!remove @شخص` أو `!remove رقم` حذف مشاركة',
          '`!reset تأكيد` تصفير كل شي',
        ].join('\n')
      );
    return message.reply({ embeds: [embed] });
  }

  if (!conf) return message.reply('سوّ `!setup` أول.');

  if (cmd === 'stop') {
    conf.active = false;
    save();
    return message.reply('⏹️ تم إيقاف المسابقة. أي صورة بتنمسح وما بتنرسل للتصويت.');
  }

  if (cmd === 'resume') {
    conf.active = true;
    conf.ended = false;
    save();
    return message.reply('▶️ تم تشغيل المسابقة وفتح التصويت.');
  }

  if (cmd === 'status') {
    const embed = new EmbedBuilder()
      .setColor(COLOR)
      .setTitle('حالة المسابقة')
      .addFields(
        {
          name: 'الحالة',
          value: conf.ended ? '🏁 منتهية (التصويت مقفل)' : conf.active ? '🟢 شغالة' : '🔴 موقوفة',
          inline: true,
        },
        { name: 'المشاركين', value: String(Object.keys(conf.entries).length), inline: true },
        { name: 'عدد الفايزين', value: String(conf.winners), inline: true },
        {
          name: 'أقل عمر حساب للتصويت',
          value: conf.minAccountDays ? `${conf.minAccountDays} يوم` : 'غير محدد',
          inline: true,
        },
        { name: 'التصويت لنفسه', value: conf.allowSelfVote ? 'مسموح' : 'ممنوع', inline: true },
        { name: 'روم الصور', value: `<#${conf.submitChannel}>`, inline: true },
        { name: 'روم التصويت', value: `<#${conf.voteChannel}>`, inline: true }
      );
    return message.reply({ embeds: [embed] });
  }

  if (cmd === 'top' || cmd === 'end') {
    const final = cmd === 'end';
    if (final) {
      conf.active = false;
      conf.ended = true; // قفل التصويت قبل الحساب
      save();
    }

    const wait = await message.reply('⏳ جاري حساب الأصوات الصالحة...');
    const scores = await recountAll(guild, conf);
    const embed = buildResultsEmbed(scores, conf, { final });

    if (final) {
      const voteCh = await guild.channels.fetch(conf.voteChannel).catch(() => null);
      if (voteCh && voteCh.id !== message.channel.id) {
        await voteCh.send({ embeds: [embed] }).catch(() => {});
      }
    }
    return wait.edit({
      content: final ? '🏁 تم إنهاء المسابقة وقفل التصويت.' : null,
      embeds: [embed],
      allowedMentions: { parse: [] },
    });
  }

  if (cmd === 'winners') {
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 1 || n > 10) {
      return message.reply('الاستخدام: `!winners 3` (من 1 إلى 10)');
    }
    conf.winners = n;
    save();
    return message.reply(`✅ عدد الفايزين صار **${n}**.`);
  }

  if (cmd === 'minage') {
    const n = Number(args[0]);
    if (!Number.isInteger(n) || n < 0 || n > 365) {
      return message.reply('الاستخدام: `!minage 7` (عدد الأيام من 0 إلى 365، و0 يعطّل الشرط)');
    }
    conf.minAccountDays = n;
    save();
    scheduleAll(guild.id); // إعادة حساب الأصوات بالشرط الجديد
    return message.reply(
      n ? `✅ الحسابات الأحدث من **${n}** يوم ما تنحسب أصواتها.` : '✅ تم تعطيل شرط عمر الحساب.'
    );
  }

  if (cmd === 'selfvote') {
    const v = (args[0] || '').toLowerCase();
    if (!['on', 'off'].includes(v)) {
      return message.reply('الاستخدام: `!selfvote on` أو `!selfvote off`');
    }
    conf.allowSelfVote = v === 'on';
    save();
    scheduleAll(guild.id);
    return message.reply(
      conf.allowSelfVote ? '✅ صار مسموح التصويت لنفسه.' : '✅ صار ممنوع التصويت لنفسه.'
    );
  }

  if (cmd === 'remove') {
    let userId = message.mentions.users.first()?.id;
    const arg = args[0] || '';
    if (!userId && /^\d{1,6}$/.test(arg)) {
      userId = Object.keys(conf.entries).find((k) => conf.entries[k].number === Number(arg));
    } else if (!userId && /^\d{17,20}$/.test(arg)) {
      userId = arg;
    }
    const entry = userId && conf.entries[userId];
    if (!entry) {
      return message.reply('❌ ما لقيت المشاركة. الاستخدام: `!remove @شخص` أو `!remove رقم`');
    }

    const voteCh = await guild.channels.fetch(conf.voteChannel).catch(() => null);
    if (voteCh && entry.messageId) {
      const msg = await voteCh.messages.fetch(entry.messageId).catch(() => null);
      await msg?.delete().catch(() => {});
    }
    delete conf.entries[userId];
    save();
    return message.reply(
      `🗑️ تم حذف مشاركة المتسابق رقم **${entry.number}**، ويقدر يشارك من جديد.`
    );
  }

  if (cmd === 'reset') {
    if (!['تأكيد', 'تاكيد', 'confirm'].includes((args[0] || '').toLowerCase())) {
      return message.reply('⚠️ هذا يصفّر الترقيم والمشاركين. للتأكيد اكتب: `!reset تأكيد`');
    }
    conf.count = 0;
    conf.entries = {};
    conf.ended = false;
    save();
    return message.reply('🔄 تم تصفير الترقيم والمشاركين، الكل يقدر يشارك من جديد.');
  }
}

const COMMANDS = [
  'setup', 'stop', 'resume', 'end', 'top', 'status', 'winners',
  'minage', 'remove', 'selfvote', 'reset', 'help',
];

// ---------- معالجة الصور ----------
async function handleSubmission(message, conf) {
  const userId = message.author.id;
  const deleteOriginal = () => message.delete().catch(() => {});

  // المسابقة موقوفة أو منتهية -> امسح بدون إرسال
  if (!conf.active || conf.ended) return deleteOriginal();

  const problem = checkSubmission(message);
  if (problem) {
    await deleteOriginal();
    return warn(message.channel, userId, problem);
  }

  // كل شخص مرة وحدة
  if (conf.entries[userId] || busyUsers.has(userId)) {
    await deleteOriginal();
    return warn(message.channel, userId, 'شاركت من قبل، كل شخص له مشاركة وحدة فقط.');
  }

  busyUsers.add(userId);
  let number = null;

  try {
    const file = message.attachments.first();
    const res = await fetch(file.url);
    if (!res.ok) throw new Error(`فشل تحميل الصورة (${res.status})`);
    const buffer = Buffer.from(await res.arrayBuffer());

    const voteChannel = await message.guild.channels.fetch(conf.voteChannel);

    // حجز الرقم قبل الإرسال
    number = ++conf.count;
    const entry = { number, messageId: null, username: message.author.username, votes: 0, shown: 0 };
    conf.entries[userId] = entry;

    const ext = file.name.split('.').pop().toLowerCase();
    const sent = await voteChannel.send({
      content: buildContent(entry, userId, 0),
      files: [new AttachmentBuilder(buffer, { name: `contestant-${number}.${ext}` })],
      allowedMentions: { parse: [] }, // بدون منشن
    });

    entry.messageId = sent.id;
    save();

    await sent.react(STAR).catch((e) => console.error('فشل إضافة النجمة:', e.message));
  } catch (err) {
    console.error('خطأ في إرسال الصورة:', err);

    // تراجع عن الحجز عشان الشخص يقدر يعيد المحاولة
    if (number !== null) {
      delete conf.entries[userId];
      if (conf.count === number) conf.count -= 1;
      save();
    }
    await warn(message.channel, userId, 'صار خطأ بإرسال صورتك، جرب مرة ثانية.');
  } finally {
    busyUsers.delete(userId);
    await deleteOriginal();
  }
}

// ---------- الأحداث ----------
client.once('clientReady', () => {
  console.log(`✅ شغال: ${client.user.tag}`);
  // حساب شامل عند التشغيل (يلحق أي تغيير صار والبوت طافي) ثم بشكل دوري
  const sweep = () => {
    for (const guildId of Object.keys(data)) scheduleAll(guildId);
  };
  sweep();
  setInterval(sweep, SWEEP_EVERY_MS);
});

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot || !message.guild) return;

    const conf = getConf(message.guild.id);
    const inPhotoRoom = conf && message.channel.id === conf.submitChannel;

    // الأوامر (للإدارة فقط)
    if (message.content.startsWith(PREFIX)) {
      const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
      const cmd = (args.shift() || '').toLowerCase();
      if (COMMANDS.includes(cmd)) {
        const isAdmin = message.member?.permissions.has(PermissionsBitField.Flags.ManageGuild);
        if (isAdmin) return await handleCommand(message, cmd, args);
        if (!inPhotoRoom) return await message.reply('❌ الأمر للإدارة فقط.');
        // داخل روم الصور يكمل ويتحذف مثل أي رسالة ثانية
      }
    }

    if (inPhotoRoom) await handleSubmission(message, conf);
  } catch (err) {
    console.error('خطأ غير متوقع:', err);
  }
});

// تصويت جديد
client.on('messageReactionAdd', async (reaction, user) => {
  try {
    if (user.bot) return;
    if (reaction.partial) await reaction.fetch();
    const msg = reaction.message;
    if (!msg.guildId) return;

    const conf = getConf(msg.guildId);
    if (!conf || msg.channelId !== conf.voteChannel) return;
    const owner = findOwner(conf, msg.id);
    if (!owner || reaction.emoji.name !== STAR) return;

    // التصويت مقفل بعد إنهاء المسابقة، أو صاحب الصورة يصوت لنفسه
    if (conf.ended || (!conf.allowSelfVote && owner === user.id)) {
      await reaction.users.remove(user.id).catch(() => {});
      return;
    }
    scheduleRefresh(msg.guildId, owner);
  } catch (err) {
    console.error('خطأ في معالجة التصويت:', err.message);
  }
});

// سحب تصويت
client.on('messageReactionRemove', async (reaction, user) => {
  try {
    if (user.bot) return;
    const msg = reaction.message;
    if (!msg.guildId) return;

    const conf = getConf(msg.guildId);
    if (!conf || conf.ended || msg.channelId !== conf.voteChannel) return;
    const owner = findOwner(conf, msg.id);
    if (!owner || reaction.emoji.name !== STAR) return;
    scheduleRefresh(msg.guildId, owner);
  } catch (err) {
    console.error('خطأ في معالجة سحب التصويت:', err.message);
  }
});

// شخص طلع من السيرفر -> نعيد حساب الأصوات (أصواته تنشال)
client.on('guildMemberRemove', (member) => {
  const conf = getConf(member.guild.id);
  if (conf && !conf.ended) scheduleAllDebounced(member.guild.id);
});

// إذا انحذفت رسالة مشاركة من روم التصويت، الشخص يقدر يشارك من جديد
client.on('messageDelete', (message) => {
  if (!message.guildId) return;
  const conf = getConf(message.guildId);
  if (!conf || message.channelId !== conf.voteChannel) return;
  const owner = findOwner(conf, message.id);
  if (owner) {
    delete conf.entries[owner];
    save();
  }
});

client.on('error', (err) => console.error('client error:', err));
process.on('unhandledRejection', (err) => console.error('unhandledRejection:', err));
process.on('SIGINT', () => {
  save();
  process.exit(0);
});

client.login(process.env.TOKEN).catch((err) => {
  console.error('❌ فشل تسجيل الدخول:', err.message);
  if (/disallowed intents/i.test(err.message)) {
    console.error(
      'فعّل Server Members Intent و Message Content Intent من Developer Portal > Bot > Privileged Gateway Intents'
    );
  }
  process.exit(1);
});
