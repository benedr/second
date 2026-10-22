"use strict";

const { createServer } = require("node:http");
const path = require("node:path");
const { Bot } = require("node-telegram-bot-api");
const { fromPath, run } = require("node-telegram-bot-api/node");

const LEVEL_COUNT = 4;
const GROUP_CHAT_LINK = process.env.GROUP_CHAT_LINK?.trim();

function createEmptyStore() {
  return { version: 1, users: {}, joins: {}, channelEntrants: {} };
}

function validateStore(store, source) {
  if (
    store.version !== 1 ||
    !store.users ||
    typeof store.users !== "object" ||
    !store.joins ||
    typeof store.joins !== "object" ||
    !store.channelEntrants ||
    typeof store.channelEntrants !== "object"
  ) {
    throw new Error(`Invalid referral data format in ${source}`);
  }
}

function parseReferralPayload(text) {
  const match = text.match(/^\/start(?:@\w+)?(?:\s+ref_(\d+))?\s*$/i);
  return match?.[1] || null;
}

function getReferralProgress(count) {
  const total = Math.max(0, Number.isFinite(count) ? Math.floor(count) : 0);
  const level = Math.min(total, LEVEL_COUNT);
  return {
    total,
    level,
    completed: level === LEVEL_COUNT,
    referralsToNext: Math.max(0, LEVEL_COUNT - total),
  };
}

function countVerifiedReferrals(store, userId) {
  const id = String(userId);
  return Object.values(store.joins).filter(
    (join) => join.inviterId === id,
  ).length;
}

function verifyChannelMember(
  store,
  userId,
  verifiedAt,
  { newEntrant = false } = {},
) {
  const id = String(userId);
  const user = store.users[id];
  if (!user) throw new Error(`Unknown channel member ${id}`);
  if (user.channelVerifiedAt) {
    delete store.channelEntrants[id];
    user.linkEligible ??= !user.isNewChannelEntrant;
    return {
      newlyVerified: false,
      isNewEntrant: Boolean(user.isNewChannelEntrant),
    };
  }

  user.channelVerifiedAt = verifiedAt;
  user.isNewChannelEntrant = newEntrant;
  user.linkEligible = !newEntrant;
  delete user.channelNotMemberCheckedAt;
  delete store.channelEntrants[id];
  return {
    newlyVerified: true,
    isNewEntrant: newEntrant,
  };
}

function completeRequiredMemberships(store, userId, completedAt) {
  const id = String(userId);
  const user = store.users[id];
  if (!user) throw new Error(`Unknown user ${id}`);
  if (!user.channelVerifiedAt || !user.groupVerifiedAt) {
    return { completed: false };
  }
  if (user.onboardingCompletedAt) {
    return {
      completed: false,
      isNewEntrant: Boolean(user.isNewChannelEntrant),
      linkEligible: user.linkEligible !== false,
    };
  }

  let inviterId = null;
  let previousCount = 0;
  let currentCount = 0;
  const pendingInviterId = user.pendingReferredById;
  if (user.isNewChannelEntrant && pendingInviterId) {
    const inviter = store.users[pendingInviterId];
    if (
      inviter?.channelVerifiedAt &&
      inviter.groupVerifiedAt &&
      inviter.onboardingCompletedAt &&
      inviter.linkEligible !== false
    ) {
      inviterId = pendingInviterId;
      previousCount = countVerifiedReferrals(store, inviterId);
      store.joins[id] = { inviterId, joinedAt: completedAt };
      currentCount = countVerifiedReferrals(store, inviterId);
      user.referredById = inviterId;
    }
  }

  user.pendingReferredById = null;
  user.onboardingCompletedAt = completedAt;
  user.linkEligible ??= !user.isNewChannelEntrant;
  return {
    completed: true,
    isNewEntrant: Boolean(user.isNewChannelEntrant),
    linkEligible: user.linkEligible,
    inviterId,
    previousCount,
    currentCount,
  };
}

function createReferralBotLink(username, userId) {
  return `https://t.me/${username}?start=ref_${userId}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[character];
  });
}

function createLevelCaption(user, progress) {
  const name = escapeHtml(
    user.username ? `@${user.username}` : user.firstName || `User ${user.id}`,
  );
  const status = progress.completed
    ? "🌈 All 4 levels are complete — redeem code rewards unlocked!"
    : `${LEVEL_COUNT - progress.level} more verified referral${
        LEVEL_COUNT - progress.level === 1 ? "" : "s"
      } to complete all 4 levels and unlock the redeem code rewards.`;
  return (
    `<b>🎉 LEVEL ${progress.level} UNLOCKED! 🎉</b>\n\n` +
    `✨ ${name} has unlocked <b>Level ${progress.level}</b>!\n` +
    `✅ <b>Total verified referrals:</b> ${progress.total}\n` +
    `🏆 <b>Levels completed:</b> ${progress.level}/${LEVEL_COUNT}\n\n` +
    `📣 ${status}`
  );
}

async function loadMongoStore(database) {
  const [userDocuments, joinDocuments, entrantDocuments, metadata] = await Promise.all([
    database.collection("emote_referral_users").find().toArray(),
    database.collection("emote_referral_joins").find().toArray(),
    database.collection("emote_referral_entrants").find().toArray(),
    database
      .collection("emote_referral_metadata")
      .findOne({ _id: "store" }),
  ]);

  if (!metadata) {
    if (userDocuments.length || joinDocuments.length || entrantDocuments.length) {
      throw new Error(
        "MongoDB contains redeem-code referral records but is missing store metadata",
      );
    }
    return createEmptyStore();
  }

  const store = {
    version: metadata.version,
    users: Object.fromEntries(
      userDocuments.map(({ _id, ...user }) => [String(_id), user]),
    ),
    joins: Object.fromEntries(
      joinDocuments.map(({ _id, ...join }) => [String(_id), join]),
    ),
    channelEntrants: Object.fromEntries(
      entrantDocuments.map(({ _id, ...entrant }) => [String(_id), entrant]),
    ),
  };
  validateStore(store, "MongoDB");
  return store;
}

async function initializeMongoStore(database) {
  for (const name of [
    "emote_referral_users",
    "emote_referral_joins",
    "emote_referral_entrants",
    "emote_referral_metadata",
  ]) {
    try {
      await database.createCollection(name);
    } catch (error) {
      if (error.code !== 48) throw error;
    }
  }
}

async function saveMongoStore(client, database, previousStore, store) {
  const session = client.startSession();
  const collections = [
    ["emote_referral_users", previousStore.users, store.users],
    ["emote_referral_joins", previousStore.joins, store.joins],
    [
      "emote_referral_entrants",
      previousStore.channelEntrants,
      store.channelEntrants,
    ],
  ];
  try {
    await session.withTransaction(async () => {
      for (const [name, previous, current] of collections) {
        const operations = [];
        for (const [id, value] of Object.entries(current)) {
          if (JSON.stringify(previous[id]) === JSON.stringify(value)) continue;
          operations.push({
            replaceOne: {
              filter: { _id: id },
              replacement: { _id: id, ...value },
              upsert: true,
            },
          });
        }
        for (const id of Object.keys(previous)) {
          if (!(id in current)) operations.push({ deleteOne: { filter: { _id: id } } });
        }
        if (operations.length) {
          await database.collection(name).bulkWrite(operations, { session });
        }
      }
      await database.collection("emote_referral_metadata").updateOne(
        { _id: "store" },
        { $set: { version: store.version } },
        { upsert: true, session },
      );
    });
  } finally {
    await session.endSession();
  }
}

function isChannelMember(member) {
  return (
    member.status === "creator" ||
    member.status === "administrator" ||
    member.status === "member" ||
    (member.status === "restricted" && member.is_member)
  );
}

function isGroupMember(member) {
  return isChannelMember(member);
}

function isNewChannelMember(oldMember, newMember) {
  const wasMember = isChannelMember(oldMember);
  const isMember = isChannelMember(newMember);
  return !wasMember && isMember;
}

function createTestLevelCaption(user, level) {
  return (
    `<b>🧪 TEST PREVIEW — Redeem Code ${level}</b>\n` +
    "<i>No referral data was changed.</i>\n\n" +
    createLevelCaption(user, getReferralProgress(level))
  );
}

function createHealthServer() {
  return createServer((request, response) => {
    if (request.method === "GET" && request.url?.split("?")[0] === "/health") {
      response.writeHead(200, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end("ok\n");
      return;
    }
    response.writeHead(404);
    response.end("not found\n");
  });
}

function createBot({
  token,
  channelId,
  channelLink,
  groupChatLink,
  groupChatId = "",
  adminIds = [],
  mongoClient,
  mongoDatabase,
}) {
  const bot = new Bot(token);
  let store;
  let username;
  let writeQueue = Promise.resolve();

  function transact(change) {
    const operation = writeQueue.then(async () => {
      const previousStore = structuredClone(store);
      try {
        const result = change(store);
        await saveMongoStore(mongoClient, mongoDatabase, previousStore, store);
        return result;
      } catch (error) {
        store = previousStore;
        throw error;
      }
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  function referralLink(userId) {
    return createReferralBotLink(username, userId);
  }

  async function sendInstructions(
    ctx,
    userId,
    {
      channelMember = false,
      groupMember = false,
      linkEligible = false,
    } = {},
  ) {
    const ready = channelMember && groupMember;
    const text = ready
      ? linkEligible
        ? "✅ <b>Membership verified!</b>\n\n" +
          `🔗 <b>Your personal referral link</b>\n${escapeHtml(referralLink(username, userId))}\n\n` +
          "🎯 Each verified referral unlocks one level. Complete all 4 levels to unlock the redeem code rewards.\n\n" +
          `💬 <b>Join and interact in the group to learn how to participate:</b>\n${escapeHtml(groupChatLink)}`
        : "✅ <b>Membership verified!</b>\n\n" +
          "🆕 New channel members are not eligible for a personal referral link.\n\n" +
          "💬 Introduce yourself in the group and follow the admins' instructions or pinned posts to learn how to participate."
      : "🔐 <b>Complete both required memberships</b>\n\n" +
        `${channelMember ? "✅" : "1️⃣"} <b>Channel:</b> ${escapeHtml(channelLink)}\n` +
        `${groupMember ? "✅" : "2️⃣"} <b>Community group:</b> ${escapeHtml(groupChatLink)}\n\n` +
        "👇 Join both, then tap <b>Verify memberships</b> below. Referral links are available only to existing channel members after both memberships are verified.";
    const keyboard = [];
    if (!channelMember) {
      keyboard.push([{ text: "📣 Join the channel", url: channelLink }]);
    }
    if (!groupMember) {
      keyboard.push([{ text: "👥 Join the group", url: groupChatLink }]);
    }
    if (!ready) {
      keyboard.push([
        {
          text: "✅ Verify memberships",
          callback_data: "verify_memberships",
        },
      ]);
    } else if (linkEligible) {
      keyboard.push([{ text: "💬 Open the community group", url: groupChatLink }]);
    }
    keyboard.push([{ text: "Join BIGWIN", url: "https://bigwiin.it.com" }]);
    await bot.api.sendPhoto({
      chat_id: userId,
      photo: await fromPath(path.join(__dirname, "img", "redeem1.jfif")),
      caption: text,
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: keyboard,
      },
    });
  }

  async function announceNewChannelEntrant(update) {
    const userId = String(update.new_chat_member.user.id);
    if (String(update.chat.id) !== channelId) return;
    if (!isNewChannelMember(update.old_chat_member, update.new_chat_member)) {
      return;
    }
    if (store.users[userId]?.channelVerifiedAt) return;
    const joinedAt = new Date(update.date * 1000).toISOString();
    await transact((data) => {
      if (!data.users[userId]?.channelVerifiedAt) {
        data.channelEntrants[userId] = { joinedAt };
      }
    });
  }

  async function verifyRequiredMemberships(userId, telegramUserId) {
    const [channelMemberInfo, groupMemberInfo] = await Promise.all([
      bot.api.getChatMember({ chat_id: channelId, user_id: telegramUserId }),
      bot.api.getChatMember({ chat_id: groupChatId, user_id: telegramUserId }),
    ]);
    const channelMember = isChannelMember(channelMemberInfo);
    const groupMember = isGroupMember(groupMemberInfo);
    const checkedAt = new Date().toISOString();
    let completion = { completed: false };
    let isNewEntrant = false;

    await transact((data) => {
      const user = data.users[String(userId)];
      if (channelMember) {
        isNewEntrant = Boolean(
          user.isNewChannelEntrant ||
            data.channelEntrants[String(userId)] ||
            user.channelNotMemberCheckedAt,
        );
        verifyChannelMember(data, userId, checkedAt, {
          newEntrant: isNewEntrant,
        });
      } else if (!user.channelVerifiedAt) {
        user.channelNotMemberCheckedAt ??= checkedAt;
      }

      user.groupVerifiedAt = groupMember ? checkedAt : null;
      if (channelMember && groupMember) {
        completion = completeRequiredMemberships(data, userId, checkedAt);
      }
    });

    return {
      channelMember,
      groupMember,
      completion,
      linkEligible: Boolean(store.users[String(userId)].linkEligible),
    };
  }

  async function startUser(ctx, referralUserId) {
    const sender = ctx.message.from;
    const userId = String(sender.id);
    let invalidInviter = false;

    await transact((data) => {
      let user = data.users[userId];
      if (!user) {
        user = {
          id: userId,
          username: sender.username || null,
          firstName: sender.first_name || "",
          channelVerifiedAt: null,
          referredById: null,
          pendingReferredById: null,
          referralStartedById: null,
        };
        data.users[userId] = user;
      } else {
        user.username = sender.username || null;
        user.firstName = sender.first_name || user.firstName;
      }

      if (
        referralUserId &&
        referralUserId !== userId &&
        !user.referralStartedById &&
        !user.referredById &&
        !user.channelVerifiedAt
      ) {
        const inviter = data.users[referralUserId];
        if (
          inviter?.channelVerifiedAt &&
          inviter.groupVerifiedAt &&
          inviter.onboardingCompletedAt &&
          inviter.linkEligible !== false
        ) {
          user.referralStartedById = referralUserId;
          user.pendingReferredById = referralUserId;
        } else {
          invalidInviter = true;
        }
      }
    });

    const verification = await verifyRequiredMemberships(userId, sender.id);

    if (invalidInviter) {
      await ctx.reply(
        "⚠️ <b>This referral link cannot credit an inviter.</b>\n\n" +
          "Referral credit applies only to a new channel member after both memberships are verified. You can still complete the required memberships.",
        { parse_mode: "HTML" },
      );
    }

    if (
      verification.completion.inviterId &&
      verification.completion.currentCount >
        verification.completion.previousCount
    ) {
      await announceLevelUp(
        verification.completion.inviterId,
        verification.completion.previousCount,
        verification.completion.currentCount,
      );
    }
    await sendInstructions(ctx, userId, {
      channelMember: verification.channelMember,
      groupMember: verification.groupMember,
      linkEligible: verification.linkEligible,
    });
  }

  async function announceLevelUp(userId, previousCount, currentCount) {
    const previousLevel = getReferralProgress(previousCount).level;
    const progress = getReferralProgress(currentCount);
    if (progress.level <= previousLevel || progress.level === 0) return;
    const user = store.users[String(userId)];
    const caption = createLevelCaption(user, progress);
    const imagePath = path.join(
      __dirname,
      "img",
      `redeem${progress.level}.jfif`,
    );
    const sends = [
      bot.api.sendPhoto({
        chat_id: userId,
        photo: await fromPath(imagePath),
        caption,
        parse_mode: "HTML",
      }),
      bot.api.sendPhoto({
        chat_id: channelId,
        photo: await fromPath(imagePath),
        caption,
        parse_mode: "HTML",
      }),
    ];
    sends.push(
      bot.api.sendPhoto({
        chat_id: groupChatId,
        photo: await fromPath(imagePath),
        caption,
        parse_mode: "HTML",
      }),
    );
    await Promise.all(sends);
  }

  async function sendTestAnnouncements(ctx) {
    const user = {
      id: String(ctx.message.from.id),
      username: ctx.message.from.username || null,
      firstName: ctx.message.from.first_name || "Admin",
    };
    const destinations = [channelId, groupChatId];

    for (let level = 1; level <= LEVEL_COUNT; level += 1) {
      const caption = createTestLevelCaption(user, level);
      const imagePath = path.join(__dirname, "img", `redeem${level}.jfif`);
      for (const chatId of [ctx.message.from.id, ...destinations]) {
        await bot.api.sendPhoto({
          chat_id: chatId,
          photo: await fromPath(imagePath),
          caption,
          parse_mode: "HTML",
        });
      }
    }

    await ctx.reply(
      "✅ <b>Test previews sent!</b>\n\n📨 Check this chat, the channel, and the group. No referral data was changed.",
      { parse_mode: "HTML" },
    );
  }

  bot.on("message", async (ctx) => {
    const message = ctx.message;
    if (!message?.from || !message.text) return;
    const text = message.text.trim();

    if (message.chat.type === "group" || message.chat.type === "supergroup") {
      if (/^\/groupid(?:@\w+)?(?:\s|$)/i.test(text)) {
        await ctx.reply(
          `🆔 <b>This group's numeric chat ID:</b> <code>${message.chat.id}</code>`,
          { parse_mode: "HTML" },
        );
      }
      return;
    }
    if (message.chat.type !== "private") return;

    if (/^\/testannounce(?:@\w+)?(?:\s|$)/i.test(text)) {
      if (!adminIds.includes(String(message.from.id))) {
        await ctx.reply("⛔ <b>This command is only available to configured admins.</b>", {
          parse_mode: "HTML",
        });
        return;
      }
      await sendTestAnnouncements(ctx);
      return;
    }

    const referralUserId = parseReferralPayload(text);
    if (/^\/start(?:@\w+)?(?:\s|$)/i.test(text)) {
      await startUser(ctx, referralUserId);
      return;
    }
    if (/^\/stats(?:@\w+)?(?:\s|$)/i.test(text)) {
      const userId = String(message.from.id);
      const user = store.users[userId];
      if (!user) {
        await ctx.reply("👋 Send /start first to set up your account.", {
          parse_mode: "HTML",
        });
        return;
      }
      const progress = getReferralProgress(
        countVerifiedReferrals(store, userId),
      );
      await ctx.reply(
        `<b>📊 Your referral progress</b>\n\n` +
          `✅ Verified referrals: <b>${progress.total}</b>\n` +
          `🏆 Levels completed: <b>${progress.level}/${LEVEL_COUNT}</b>\n\n` +
          (user.onboardingCompletedAt &&
          user.linkEligible !== false &&
          user.channelVerifiedAt &&
          user.groupVerifiedAt
            ? `🔗 <b>Your referral link:</b>\n${escapeHtml(referralLink(userId))}`
            : "🔐 Complete and verify both channel and group membership. Only eligible existing channel members receive referral links."),
        { parse_mode: "HTML" },
      );
    }
  });

  bot.on("callback_query", async (ctx) => {
    const query = ctx.callbackQuery;
    if (
      query?.data !== "verify_memberships" &&
      query?.data !== "verify_channel"
    ) {
      return;
    }
    if (query.message?.chat.type !== "private") {
      await ctx.answerCallbackQuery({ text: "💬 Open the bot in a private chat." });
      return;
    }

    const userId = String(query.from.id);
    const user = store.users[userId];
    if (!user) {
      await ctx.answerCallbackQuery({ text: "👋 Send /start first." });
      return;
    }

    const verification = await verifyRequiredMemberships(userId, query.from.id);
    if (!verification.channelMember || !verification.groupMember) {
      const missing = [
        !verification.channelMember ? "channel" : null,
        !verification.groupMember ? "group" : null,
      ]
        .filter(Boolean)
        .join(" and ");
      await ctx.answerCallbackQuery({
        text: `🔒 Please join the ${missing} first.`,
      });
      await sendInstructions(ctx, userId, {
        channelMember: verification.channelMember,
        groupMember: verification.groupMember,
        linkEligible: verification.linkEligible,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: "✅ Both channel and group memberships are verified!",
    });
    if (
      verification.completion.inviterId &&
      verification.completion.currentCount >
        verification.completion.previousCount
    ) {
      await announceLevelUp(
        verification.completion.inviterId,
        verification.completion.previousCount,
        verification.completion.currentCount,
      );
    }
    await sendInstructions(ctx, userId, {
      channelMember: verification.channelMember,
      groupMember: verification.groupMember,
      linkEligible: verification.linkEligible,
    });
  });

  bot.on("chat_member", async (ctx) => {
    await announceNewChannelEntrant(ctx.update.chat_member);
  });

  bot.catch((error, ctx) => {
    const updateId = ctx?.update?.update_id ?? "unknown";
    console.error(`Telegram update ${updateId} failed:`, error);
  });

  async function start() {
    await initializeMongoStore(mongoDatabase);
    store = await loadMongoStore(mongoDatabase);
    const me = await bot.api.getMe();
    username = me.username;
    if (!username) throw new Error("Telegram did not return a bot username");

    if (process.env.PORT) {
      const port = Number(process.env.PORT);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error("PORT must be a valid TCP port number");
      }
      const server = createHealthServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "0.0.0.0", resolve);
      });
      server.on("error", (error) => console.error("Health server error:", error));
      console.log(`Health endpoint listening on port ${port}`);
    }
    console.log(`Starting @${username}; tracking channel ${channelId}`);
    await run(bot, {
      allowedUpdates: ["message", "callback_query", "chat_member"],
    });
  }

  return { start };
}

async function main() {
  const token = process.env.BOT_TOKEN?.trim();
  const channelId = process.env.CHANNEL_ID?.trim();
  const channelLink = process.env.CHANNEL_LINK?.trim();
  const groupChatLink = GROUP_CHAT_LINK;
  const groupChatId = process.env.GROUP_CHAT_ID?.trim() || "";
  const adminIds = (process.env.ADMIN_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const mongoUri = process.env.MONGODB_URI?.trim();
  const databaseName = process.env.MONGODB_DB_NAME?.trim();

  if (!token) throw new Error("BOT_TOKEN is required");
  if (!channelId || !/^-?\d+$/.test(channelId)) {
    throw new Error("CHANNEL_ID must be the channel's numeric Telegram ID");
  }
  if (!channelLink || !/^https:\/\/t\.me\/\S+$/i.test(channelLink)) {
    throw new Error("CHANNEL_LINK must be a Telegram channel URL");
  }
  if (!groupChatLink || !/^https:\/\/t\.me\/\S+$/i.test(groupChatLink)) {
    throw new Error("GROUP_CHAT_LINK must be a Telegram group invite URL");
  }
  if (!groupChatId || !/^-?\d+$/.test(groupChatId)) {
    throw new Error("GROUP_CHAT_ID must be the group's numeric Telegram ID");
  }
  if (!mongoUri) throw new Error("MONGODB_URI is required");
  if (!databaseName) throw new Error("MONGODB_DB_NAME is required");

  const { MongoClient } = require("mongodb");
  const mongoClient = new MongoClient(mongoUri);
  try {
    await mongoClient.connect();
    await createBot({
      token,
      channelId,
      channelLink,
      groupChatLink,
      groupChatId,
      adminIds,
      mongoClient,
      mongoDatabase: mongoClient.db(databaseName),
    }).start();
  } catch (error) {
    await mongoClient.close();
    throw error;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error("Bot stopped:", error);
    process.exitCode = 1;
  });
}

module.exports = {
  LEVEL_COUNT,
  countVerifiedReferrals,
  completeRequiredMemberships,
  createEmptyStore,
  createHealthServer,
  createLevelCaption,
  createTestLevelCaption,
  createReferralBotLink,
  getReferralProgress,
  initializeMongoStore,
  isChannelMember,
  isNewChannelMember,
  loadMongoStore,
  parseReferralPayload,
  verifyChannelMember,
  saveMongoStore,
  validateStore,
};
