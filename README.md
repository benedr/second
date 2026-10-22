# Telegram Redeem Code Referral Bot

This is a separate bot from the original project. MongoDB is its only
persistent store. It does not watch group joins or count people who joined the
group before using this bot.

## Referral flow

1. A participant starts the bot. The bot checks their channel and group
   memberships immediately.
2. Anyone missing either membership is asked to join the configured channel
   and group, then tap the verification button. Telegram checks both directly.
3. Participants already in the channel before they first use the bot receive
   their personal referral link after both memberships are verified. Existing
   membership does not earn referral credit for an inviter.
4. New channel entrants must join both. They receive private instructions to
   introduce themselves and follow the group's pinned posts or admin
   instructions, but never receive a personal referral link.
5. A referred new participant earns referral credit for the inviter only after
   both memberships are verified. Inviter links are accepted only for members
   who have completed both verification steps.
6. Each verified referral unlocks one redeem code level. Levels 1–4 use
   `img/redeem1.jfif` through `img/redeem4.jfif`. Four verified referrals unlock
   all four redeem codes; later referrals do not unlock additional codes.

Both channel and group membership are mandatory. The bot checks memberships
when users start and whenever they tap the verification button; it does not
subscribe to group-member updates. It does subscribe to channel member updates
to distinguish new channel entrants from existing channel members. Joining or
verifying does not post a welcome or member-progress announcement. Only redeem
code level-unlock announcements are posted to both the channel and group when
an inviter reaches a new level. `GROUP_CHAT_ID` and `GROUP_CHAT_LINK` are
required. Add the bot as a channel administrator and make it an administrator
in the group, then send `/groupid` there to learn its numeric chat ID. Set that
ID and the group invite link, then restart the service.

The `redeem1.jfif` card is also shown with onboarding and verification
instructions. Level-ups use the corresponding `redeem1.jfif` through
`redeem4.jfif` image in the private chat, channel, and configured group.
Messages use Telegram's supported HTML bold/italic formatting and colorful
emoji; Telegram bots cannot set arbitrary text colors.

## Preview announcements

Set `ADMIN_IDS` to your Telegram numeric user ID, restart the bot, and send
`/testannounce` in your private chat with it. The command posts clearly marked
test examples of the four level-unlock announcements to your private chat, the
channel, and the configured group. It does not change referral data. These are
real public test messages, so only run it when it is appropriate to post in
those destinations.

## Configure and run

Copy `.env.example` to `.env` and fill in the values privately. Make the bot an
administrator in the channel so it can check membership and post announcements.
Make it a group administrator so it can check memberships and send announcements
there.
Set the same MongoDB URI and database name in local `.env` and the deployed
service if both should access the same records. Use a separate Atlas database
from the original bot.

```powershell
npm install
node --env-file=.env bot.js
```

For Render, use `npm install` as the build command and `npm start` as the start
command. Set the environment variables in the Render service settings. The
service exposes `GET /health` using Render's `PORT`.

The bot creates `emote_referral_users`, `emote_referral_joins`, and
`emote_referral_metadata` collections in MongoDB. It has no JSON/file-storage
fallback. Those collection names and the configured database name are kept
stable so existing bot records remain available after this wording change.
Back up the database through Atlas.

Run automated tests with `npm test`.
