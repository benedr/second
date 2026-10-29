"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { existsSync } = require("node:fs");
const path = require("node:path");
const {
  countVerifiedReferrals,
  createEmptyStore,
  createLevelCaption,
  createTestLevelCaption,
  createReferralBotLink,
  completeRequiredMemberships,
  getReferralProgress,
  initializeMongoStore,
  isChannelMember,
  loadMongoStore,
  isNewChannelMember,
  parseReferralPayload,
  saveMongoStore,
  verifyChannelMember,
} = require("../bot");

test("referral start payloads accept numeric inviter IDs only", () => {
  assert.equal(parseReferralPayload("/start"), null);
  assert.equal(parseReferralPayload("/start ref_12345"), "12345");
  assert.equal(parseReferralPayload("/start@RedeemBot ref_12345"), "12345");
  assert.equal(parseReferralPayload("/start ref_invalid"), null);
  assert.equal(parseReferralPayload("/start ref_12 trailing"), null);
});

test("two verified referrals unlock one Yum Emote level, capped at five", () => {
  assert.deepEqual(getReferralProgress(0), {
    total: 0,
    level: 0,
    completed: false,
    referralsToNext: 10,
  });
  assert.equal(getReferralProgress(1).level, 0);
  assert.equal(getReferralProgress(2).level, 1);
  assert.equal(getReferralProgress(4).level, 2);
  assert.equal(getReferralProgress(6).level, 3);
  assert.equal(getReferralProgress(8).level, 4);
  assert.equal(getReferralProgress(9).level, 4);
  assert.equal(getReferralProgress(10).completed, true);
  assert.equal(getReferralProgress(12).level, 5);
});

test("referral links use the Telegram start payload", () => {
  assert.equal(
    createReferralBotLink("RedeemBot", "987654"),
    "https://t.me/RedeemBot?start=ref_987654",
  );
});

test("each pair of verified referrals unlocks a level and five levels unlock rewards", () => {
  assert.match(
    createLevelCaption(
      { id: "1", username: "alice" },
      getReferralProgress(4),
    ),
    /alice has unlocked <b>Level 2<\/b>!/,
  );
  assert.match(
    createLevelCaption(
      { id: "1", username: "alice" },
      getReferralProgress(1),
    ),
    /9 more verified referrals to complete all 5 levels/,
  );
  assert.match(
    createLevelCaption(
      { id: "1", firstName: "Alice" },
      getReferralProgress(10),
    ),
    /😋 All 5 levels are complete — Yum Emote rewards unlocked!/,
  );
});

test("test announcements preview all five Yum Emote level-unlock cards", () => {
  for (let level = 1; level <= 5; level += 1) {
    const caption = createTestLevelCaption(
      { id: "1", username: "alice" },
      level,
    );
    assert.ok(caption.includes(`🧪 TEST PREVIEW — Yum Emote ${level}`));
    assert.ok(caption.includes(`LEVEL ${level} UNLOCKED`));
    assert.ok(caption.includes(`alice has unlocked <b>Level ${level}</b>!`));
    assert.doesNotMatch(
      caption,
      /welcome|new channel member|existing member verified/i,
    );
  }
});

test("initial and five level-up emote images are available", () => {
  const imageDirectory = path.join(__dirname, "..", "img", "emote");
  assert.equal(existsSync(path.join(imageDirectory, "emote initial.jfif")), true);
  for (let level = 1; level <= 5; level += 1) {
    assert.equal(
      existsSync(path.join(imageDirectory, `emote${level}.jfif`)),
      true,
    );
  }
});

test("level announcement names are safely formatted as Telegram HTML", () => {
  assert.match(
    createLevelCaption(
      { id: "1", firstName: "<Alice & Bob>" },
      getReferralProgress(1),
    ),
    /&lt;Alice &amp; Bob&gt; has unlocked/,
  );
});

test("membership verification accepts channel member roles", () => {
  assert.equal(isChannelMember({ status: "member" }), true);
  assert.equal(isChannelMember({ status: "administrator" }), true);
  assert.equal(isChannelMember({ status: "creator" }), true);
  assert.equal(
    isChannelMember({ status: "restricted", is_member: true }),
    true,
  );
  assert.equal(
    isChannelMember({ status: "restricted", is_member: false }),
    false,
  );
  assert.equal(isChannelMember({ status: "left" }), false);
});

test("only joins observed after tracking starts count as new channel entrants", () => {
  assert.equal(
    isNewChannelMember(
      { status: "left" },
      { status: "member" },
    ),
    true,
  );
  assert.equal(
    isNewChannelMember(
      { status: "member" },
      { status: "member" },
    ),
    false,
  );
});

test("existing channel members are verified and not credited as referral joins", () => {
  const store = createEmptyStore();
  store.users["10"] = {
    id: "10",
    channelVerifiedAt: "previously-verified",
  };
  store.users["20"] = {
    id: "20",
    channelVerifiedAt: null,
    referredById: null,
    pendingReferredById: "10",
  };

  const result = verifyChannelMember(store, "20", "already-in-channel");
  assert.equal(result.newlyVerified, true);
  assert.equal(result.isNewEntrant, false);
  assert.equal(store.users["20"].channelVerifiedAt, "already-in-channel");
  assert.equal(store.users["20"].referredById, null);
  assert.equal(store.users["20"].pendingReferredById, "10");
  assert.deepEqual(store.joins, {});
  assert.equal(countVerifiedReferrals(store, "10"), 0);
  store.users["20"].groupVerifiedAt = "group-verified";
  const completion = completeRequiredMemberships(
    store,
    "20",
    "both-memberships-verified",
  );
  assert.equal(completion.completed, true);
  assert.equal(completion.linkEligible, true);
  assert.equal(store.users["20"].pendingReferredById, null);
  assert.deepEqual(store.joins, {});
  assert.equal(
    verifyChannelMember(store, "20", "must-not-overwrite").newlyVerified,
    false,
  );
  assert.equal(store.users["20"].channelVerifiedAt, "already-in-channel");
});

test("new entrants earn referral credit only after both memberships are verified", () => {
  const store = createEmptyStore();
  store.users["10"] = {
    id: "10",
    channelVerifiedAt: "inviter-verified",
    groupVerifiedAt: "group-verified",
    onboardingCompletedAt: "onboarding-complete",
    linkEligible: true,
  };
  store.users["20"] = {
    id: "20",
    channelVerifiedAt: null,
    pendingReferredById: "10",
  };
  store.channelEntrants["20"] = { joinedAt: "channel-joined" };

  const result = verifyChannelMember(
    store,
    "20",
    "membership-verified",
    { newEntrant: true },
  );
  assert.equal(result.isNewEntrant, true);
  assert.equal(result.inviterId, undefined);
  assert.deepEqual(store.joins, {});
  assert.equal(countVerifiedReferrals(store, "10"), 0);

  assert.equal(
    completeRequiredMemberships(
      store,
      "20",
      "channel-only-verified",
    ).completed,
    false,
  );
  store.users["20"].groupVerifiedAt = "group-verified";
  const completion = completeRequiredMemberships(
    store,
    "20",
    "both-memberships-verified",
  );
  assert.equal(completion.completed, true);
  assert.equal(completion.isNewEntrant, true);
  assert.equal(completion.linkEligible, false);
  assert.equal(completion.inviterId, "10");
  assert.equal(completion.previousCount, 0);
  assert.equal(completion.currentCount, 1);
  assert.deepEqual(store.joins["20"], {
    inviterId: "10",
    joinedAt: "both-memberships-verified",
  });
  assert.equal(store.channelEntrants["20"], undefined);
});

test("new channel entrants never become eligible for a referral link", () => {
  const store = createEmptyStore();
  store.users["20"] = { id: "20", channelVerifiedAt: null };

  verifyChannelMember(store, "20", "channel-verified", {
    newEntrant: true,
  });
  store.users["20"].groupVerifiedAt = "group-verified";
  const completion = completeRequiredMemberships(
    store,
    "20",
    "both-memberships-verified",
  );

  assert.equal(completion.completed, true);
  assert.equal(completion.linkEligible, false);
  assert.equal(store.users["20"].linkEligible, false);
});

test("MongoDB is the persistence store for users and verified referral joins", async () => {
  const collections = new Map();
  const database = {
    async createCollection(name) {
      if (collections.has(name)) {
        const error = new Error("Collection exists");
        error.code = 48;
        throw error;
      }
      collections.set(name, new Map());
    },
    collection(name) {
      if (!collections.has(name)) collections.set(name, new Map());
      const documents = collections.get(name);
      return {
        find() {
          return { toArray: async () => structuredClone([...documents.values()]) };
        },
        async findOne({ _id }) {
          return structuredClone(documents.get(_id) || null);
        },
        async bulkWrite(operations) {
          for (const operation of operations) {
            if (operation.replaceOne) {
              const { filter, replacement } = operation.replaceOne;
              documents.set(filter._id, structuredClone(replacement));
            } else if (operation.deleteOne) {
              documents.delete(operation.deleteOne.filter._id);
            }
          }
        },
        async updateOne({ _id }, update) {
          documents.set(_id, { _id, ...structuredClone(update.$set) });
        },
      };
    },
  };
  const client = {
    startSession() {
      return {
        withTransaction: async (operation) => operation(),
        endSession: async () => {},
      };
    },
  };

  await initializeMongoStore(database);
  const empty = createEmptyStore();
  const store = createEmptyStore();
  store.users["10"] = { id: "10", channelVerifiedAt: "verified" };
  store.users["20"] = {
    id: "20",
    channelVerifiedAt: "verified",
    referredById: "10",
  };
  store.joins["20"] = { inviterId: "10", joinedAt: "verified" };
  await saveMongoStore(client, database, empty, store);

  const loaded = await loadMongoStore(database);
  assert.deepEqual(loaded, store);
  assert.equal(countVerifiedReferrals(loaded, "10"), 1);
});
