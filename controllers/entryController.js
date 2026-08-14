const { v4: uuidv4 } = require("uuid");
const mongoose = require("mongoose");
const { Types } = mongoose;

const axios = require("axios");
const Jimp = require("jimp");
const QrCode = require("qrcode-reader");
const { parse } = require("querystring");

const Entry = require("../models/Entry");
const Link = require("../models/Link");
const Employee = require("../models/Employee");
const User = require("../models/User");
const Screenshot = require("../models/Screenshot");
const LikeTask = require("../models/likeTask");
const LikeLink = require("../models/likeLink");
const BalanceHistory = require("../models/BalanceHistory");

/* ------------------------ utils & helpers ------------------------ */
const asyncHandler =
  (fn) =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

const badRequest = (res, code, message, extra = {}) =>
  res.status(400).json({ code, message, ...extra });

const notFound = (res, code, message, extra = {}) =>
  res.status(404).json({ code, message, ...extra });

function isValidUpi(upi) {
  return /^[a-zA-Z0-9_.-]+@[a-zA-Z0-9.-]+$/.test(String(upi || "").trim());
}

const clamp02 = (v, def) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return def;
  return Math.max(0, Math.min(2, Math.floor(n)));
};

function toBool(v, def = false) {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (["1", "true", "yes", "y"].includes(s)) return true;
    if (["0", "false", "no", "n"].includes(s)) return false;
  }
  return def;
}

function uniq(arr) {
  const out = [];
  const seen = new Set();
  for (const x of arr || []) {
    const t = String(x || "").trim();
    if (!t) continue;
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

function safeUrl(raw) {
  const s = String(raw || "").trim();
  if (!s) throw new Error("Empty URL");
  if (/^https?:\/\//i.test(s)) return s;
  return `https://${s}`;
}

// Accepts full YouTube URLs and returns 11-char videoId or null
function extractVideoId(urlLike) {
  const u = new URL(safeUrl(urlLike));

  // watch?v=
  const v = u.searchParams.get("v");
  if (v && /^[0-9A-Za-z_-]{11}$/.test(v)) return v;

  // youtu.be/<id>
  if (u.hostname === "youtu.be" || u.hostname.endsWith(".youtu.be")) {
    const id = u.pathname.split("/").filter(Boolean)[0];
    if (id && /^[0-9A-Za-z_-]{11}$/.test(id)) return id;
  }

  // /shorts/<id>, /embed/<id>
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg[0] === "shorts" || seg[0] === "embed") {
    const id = seg[1];
    if (id && /^[0-9A-Za-z_-]{11}$/.test(id)) return id;
  }

  return null;
}

// Parses a YouTube comment/reply permalink:
// https://www.youtube.com/watch?v=VIDEO&lc=PARENT
// https://www.youtube.com/watch?v=VIDEO&lc=PARENT.REPLYKEY
function parseCommentPermalink(rawUrl) {
  const url = safeUrl(rawUrl);
  const u = new URL(url);

  const videoId = extractVideoId(url);
  const lc = u.searchParams.get("lc");

  if (!videoId || !lc) {
    throw new Error("Invalid YouTube permalink (must contain videoId + lc=...)");
  }

  const [parentId, replyKey] = lc.split(".");
  return {
    permalink: url,
    videoId,
    lc,
    parentId,
    replyKey: replyKey || null,
    isReply: !!replyKey,
  };
}

function normText(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[^\w'\s]/g, "")
    .trim()
    .toLowerCase();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function decodeUpiFromQrBuffer(buffer) {
  const img = await Jimp.read(buffer);

  const qrValue = await new Promise((resolve, reject) => {
    const qr = new QrCode();
    let done = false;

    qr.callback = (err, value) => {
      if (done) return;
      done = true;
      if (err || !value) return reject(new Error("QR decode failed"));
      resolve(value.result);
    };

    qr.decode(img.bitmap);
    setTimeout(() => !done && reject(new Error("QR decode timeout")), 5000);
  });

  const upiString = String(qrValue || "").trim();
  if (!upiString) return "";

  // upi://pay?pa=xxxx@bank&...
  if (upiString.startsWith("upi://")) {
    const qs = upiString.split("?")[1] || "";
    const parsed = parse(qs);
    return String(parsed.pa || "").trim();
  }

  return upiString;
}

/* ------------------------ YouTube API client ------------------------ */
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_TIMEOUT_MS = Number(process.env.YT_TIMEOUT_MS || 15000);
const YT_MAX_PAGES = Number(process.env.YT_MAX_PAGES || 5);

const yt = axios.create({
  baseURL: "https://www.googleapis.com/youtube/v3",
  timeout: YT_TIMEOUT_MS,
  validateStatus: () => true,
});

async function ytGetCommentThreadsByIds(ids) {
  if (!ids.length) return [];
  const resp = await yt.get("/commentThreads", {
    params: {
      key: YOUTUBE_API_KEY,
      part: "snippet",
      id: ids.join(","),
      textFormat: "plainText",
    },
  });

  if (resp.status !== 200) {
    const msg =
      resp?.data?.error?.message ||
      `YouTube API error (commentThreads.list): HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return resp.data?.items || [];
}

async function ytListRepliesByParent(parentId, pageToken = null) {
  const resp = await yt.get("/comments", {
    params: {
      key: YOUTUBE_API_KEY,
      part: "snippet",
      parentId,
      maxResults: 100,
      pageToken: pageToken || undefined,
      textFormat: "plainText",
    },
  });

  if (resp.status !== 200) {
    const msg =
      resp?.data?.error?.message ||
      `YouTube API error (comments.list): HTTP ${resp.status}`;
    throw new Error(msg);
  }
  return resp.data || {};
}

/* ------------------------- money helpers ------------------------- */

function resolveEntryPayout(entry) {
  const isEmployeeEntry =
    entry.type === 0 || (entry.type == null && entry.employeeId && !entry.userId);
  const isUserEntry = entry.type === 1 || (entry.type == null && entry.userId);

  if (isEmployeeEntry) {
    return {
      employeeId: entry.employeeId || null,
      amount: Number(entry.amount ?? NaN),
    };
  }
  if (isUserEntry) {
    return {
      employeeId: entry.worksUnder || null,
      amount: Number(entry.totalAmount ?? entry.linkAmount ?? NaN),
    };
  }
  return { employeeId: null, amount: NaN };
}

const codedError = (code, message) => {
  const err = new Error(message || code);
  err.code = code;
  return err;
};

async function applyBalanceDelta({ employeeId, delta, note, addedBy, session }) {
  if (!delta) return null;

  const filter =
    delta < 0
      ? { employeeId, balance: { $gte: Math.abs(delta) } }
      : { employeeId };

  const emp = await Employee.findOneAndUpdate(
    filter,
    { $inc: { balance: delta } },
    { new: true, session }
  );

  if (!emp) {
    const exists = await Employee.exists({ employeeId }).session(session);
    throw exists
      ? codedError("INSUFFICIENT_BALANCE", "Insufficient balance")
      : codedError("EMPLOYEE_NOT_FOUND", "Employee not found");
  }

  await BalanceHistory.create(
    [
      {
        employeeId,
        amount: delta,
        addedBy: String(addedBy || employeeId),
        note,
      },
    ],
    { session }
  );

  return emp.balance;
}

/* ------------------------------------------------------------------ */
/*  1) CREATE by employee (type 0)                                     */
/* ------------------------------------------------------------------ */
exports.createEmployeeEntry = asyncHandler(async (req, res) => {
  const { name, amount, employeeId, notes = "", upiId: manualUpi, linkId } =
    req.body;

  if (!name || amount == null || !employeeId || !linkId) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      "employeeId, linkId, name & amount required"
    );
  }

  let upiId = String(manualUpi || "").trim();

  // Optional: allow QR image to supply UPI
  if (!upiId && req.file?.buffer) {
    try {
      upiId = await decodeUpiFromQrBuffer(req.file.buffer);
    } catch (e) {
      return badRequest(res, "QR_INVALID", "Invalid or unreadable QR code");
    }
  }

  if (!upiId) return badRequest(res, "UPI_REQUIRED", "UPI ID is required");
  if (!isValidUpi(upiId))
    return badRequest(res, "INVALID_UPI", "Invalid UPI format");

  const emp = await Employee.findOne({ employeeId });
  if (!emp) return notFound(res, "EMPLOYEE_NOT_FOUND", "Employee not found");
  if (emp.balance < Number(amount))
    return badRequest(res, "INSUFFICIENT_BALANCE", "Insufficient balance");

  // uniqueness scoped to employee entries
  if (await Entry.exists({ linkId, upiId, type: 0 })) {
    return badRequest(
      res,
      "DUPLICATE_UPI",
      "This UPI ID has already been used for this link"
    );
  }

  const entry = await Entry.create({
    entryId: uuidv4(),
    type: 0,
    employeeId,
    linkId,
    name: String(name).trim(),
    upiId: String(upiId).trim(),
    amount: Number(amount),
    notes: String(notes).trim(),
  });

  res.status(201).json({ message: "Employee entry submitted", entry });
});

/* ------------------------------------------------------------------ */
/*  2) CREATE by user (type 1)                                         */
/*  ✅ SAME user resubmits => UPDATE screenshot+entry                   */
/*  ✅ Reuse checks ONLY across DIFFERENT users                         */
/* ------------------------------------------------------------------ */
exports.createUserEntry = asyncHandler(async (req, res) => {
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({
      code: "YOUTUBE_API_KEY_MISSING",
      message: "Server missing YOUTUBE_API_KEY env. Add YouTube Data API key.",
    });
  }

  const {
    userId,
    linkId,
    name,
    worksUnder,
    upiId,

    commentLinks,
    replyLinks,

    commentTexts,
    replyTexts,
  } = req.body;

  if (!linkId || !Types.ObjectId.isValid(linkId)) {
    return badRequest(
      res,
      "INVALID_OBJECT_ID",
      "Invalid linkId format (must be a 24-char hex ObjectId)"
    );
  }

  const link = await Link.findById(linkId).lean();
  if (!link) return notFound(res, "LINK_NOT_FOUND", "Invalid linkId");

  const minComments = clamp02(link.minComments, 2);
  const minReplies = clamp02(link.minReplies, 2);

  // like rule doesn't block (assumed true if required)
  const likeRequired = toBool(link.requireLike, false);
  const likedAssumed = likeRequired ? true : false;

  if (minComments === 0 && minReplies === 0) {
    return badRequest(
      res,
      "INVALID_RULES",
      "Link rules invalid: minComments and minReplies cannot both be 0"
    );
  }

  // validate required user fields
  if (!userId || !name || !worksUnder || !upiId) {
    return badRequest(
      res,
      "VALIDATION_ERROR",
      "userId, name, worksUnder, upiId required"
    );
  }

  const normalizedReqUpi = String(upiId).trim().toLowerCase();
  if (!isValidUpi(normalizedReqUpi)) {
    return badRequest(res, "INVALID_UPI", "Invalid UPI format");
  }

  const user = await User.findOne({ userId }).lean();
  if (!user) return notFound(res, "USER_NOT_FOUND", "User not found");

  const normalizedUserUpi = String(user.upiId || "").trim().toLowerCase();
  if (normalizedUserUpi !== normalizedReqUpi) {
    return badRequest(
      res,
      "UPI_MISMATCH",
      "Provided UPI does not match your account"
    );
  }

  // proof arrays
  const cLinks = uniq(Array.isArray(commentLinks) ? commentLinks : []);
  const rLinks = uniq(Array.isArray(replyLinks) ? replyLinks : []);

  if (cLinks.length < minComments) {
    return badRequest(
      res,
      "NOT_ENOUGH_COMMENTS",
      `Need at least ${minComments} comment links`,
      { required: minComments, provided: cLinks.length }
    );
  }
  if (rLinks.length < minReplies) {
    return badRequest(
      res,
      "NOT_ENOUGH_REPLIES",
      `Need at least ${minReplies} reply links`,
      { required: minReplies, provided: rLinks.length }
    );
  }

  // Parse permalinks
  let parsedComments = [];
  let parsedReplies = [];
  try {
    parsedComments = cLinks.slice(0, minComments).map(parseCommentPermalink);
    parsedReplies = rLinks.slice(0, minReplies).map(parseCommentPermalink);
  } catch (e) {
    return badRequest(
      res,
      "INVALID_PERMALINK",
      e?.message || "Invalid comment/reply permalink"
    );
  }

  if (parsedComments.some((x) => x.isReply)) {
    return badRequest(
      res,
      "COMMENT_LINK_MUST_BE_TOPLEVEL",
      "commentLinks must be top-level comment permalinks (lc without dot)."
    );
  }
  if (parsedReplies.some((x) => !x.isReply)) {
    return badRequest(
      res,
      "REPLY_LINK_MUST_BE_REPLY",
      "replyLinks must be reply permalinks (lc=parent.replyKey)."
    );
  }

  // Determine campaign videoId from Link.title URL
  const linkTitleUrl = String(link.title || "").trim();
  let campaignVideoId = null;
  try {
    campaignVideoId = linkTitleUrl ? extractVideoId(linkTitleUrl) : null;
  } catch {
    campaignVideoId = null;
  }
  campaignVideoId =
    campaignVideoId ||
    parsedComments[0]?.videoId ||
    parsedReplies[0]?.videoId ||
    null;

  if (!campaignVideoId) {
    return badRequest(
      res,
      "INVALID_VIDEO_ID",
      "Could not determine YouTube videoId from Link.title or permalinks."
    );
  }

  // Ensure all permalinks match campaign video
  const allParsed = [...parsedComments, ...parsedReplies];
  const wrongVideo = allParsed.find((x) => x.videoId !== campaignVideoId);
  if (wrongVideo) {
    return badRequest(
      res,
      "WRONG_VIDEO",
      "One or more permalinks are not from the campaign video.",
      {
        details: {
          expectedVideoId: campaignVideoId,
          gotVideoId: wrongVideo.videoId,
          permalink: wrongVideo.permalink,
        },
      }
    );
  }

  // Fetch threads for all parentIds
  const allParentIds = uniq([
    ...parsedComments.map((x) => x.parentId),
    ...parsedReplies.map((x) => x.parentId),
  ]);

  const threadMap = new Map();
  try {
    for (const ch of chunk(allParentIds, 50)) {
      const items = await ytGetCommentThreadsByIds(ch);
      for (const it of items) threadMap.set(it.id, it);
    }
  } catch (e) {
    return res.status(502).json({
      code: "YT_API_ERROR",
      message: e?.message || "YouTube API error while verifying comment threads",
    });
  }

  const actions = [];
  const reasons = [];

  // detect channelId from proof
  let detectedChannelId = null;
  function setDetectedChannel(cid, tag) {
    if (!cid) {
      reasons.push(`${tag}_MISSING_AUTHOR_CHANNEL`);
      return;
    }
    if (!detectedChannelId) detectedChannelId = cid;
    else if (detectedChannelId !== cid)
      reasons.push(`MIXED_AUTHORS:${detectedChannelId}:${cid}`);
  }

  // verify comments
  for (let i = 0; i < parsedComments.length; i++) {
    const p = parsedComments[i];
    const t = threadMap.get(p.parentId);

    if (!t) {
      reasons.push(`COMMENT_NOT_FOUND:${p.parentId}`);
      continue;
    }
    if (t?.snippet?.videoId !== campaignVideoId) {
      reasons.push(`COMMENT_WRONG_VIDEO:${p.parentId}`);
      continue;
    }

    const top = t?.snippet?.topLevelComment?.snippet;
    const author = top?.authorChannelId?.value || null;
    if (!author) {
      reasons.push(`COMMENT_AUTHOR_MISSING:${p.parentId}`);
      continue;
    }

    setDetectedChannel(author, "COMMENT");

    actions.push({
      kind: "comment",
      videoId: campaignVideoId,
      commentId: p.parentId,
      parentId: null,
      permalink: p.permalink,
      text:
        top?.textOriginal ||
        (Array.isArray(commentTexts) ? commentTexts[i] : null) ||
        null,
      authorChannelId: author,
      publishedAt: top?.publishedAt || null,
    });
  }

  // verify replies
  const usedReplyIds = new Set();
  const usedReplyParentIds = new Set();

  for (let i = 0; i < parsedReplies.length; i++) {
    const p = parsedReplies[i];
    const parentId = p.parentId;

    if (usedReplyParentIds.has(parentId)) {
      reasons.push(`REPLY_PARENT_DUPLICATE:${parentId}`);
      continue;
    }

    const parentThread = threadMap.get(parentId);
    if (!parentThread) {
      reasons.push(`REPLY_PARENT_NOT_FOUND:${parentId}`);
      continue;
    }
    if (parentThread?.snippet?.videoId !== campaignVideoId) {
      reasons.push(`REPLY_PARENT_WRONG_VIDEO:${parentId}`);
      continue;
    }

    const parentAuthor =
      parentThread?.snippet?.topLevelComment?.snippet?.authorChannelId?.value ||
      null;

    const wantReplyIdFull = p.lc;
    const wantReplyIdShort = p.replyKey;

    let pageToken = null;
    let found = null;

    for (let page = 0; page < YT_MAX_PAGES; page++) {
      let data;
      try {
        data = await ytListRepliesByParent(parentId, pageToken);
      } catch {
        reasons.push(`REPLY_API_ERROR:${parentId}`);
        break;
      }

      const items = data?.items || [];
      for (const r of items) {
        const rid = r?.id || null;
        if (!rid) continue;
        if (rid === wantReplyIdFull || (wantReplyIdShort && rid === wantReplyIdShort)) {
          found = r;
          break;
        }
      }

      if (found) break;
      pageToken = data?.nextPageToken || null;
      if (!pageToken) break;
    }

    if (!found) {
      reasons.push(`REPLY_NOT_FOUND:${parentId}`);
      continue;
    }

    if (usedReplyIds.has(found.id)) {
      reasons.push(`REPLY_DUPLICATE_ID:${found.id}`);
      continue;
    }

    const sn = found?.snippet;
    const replyAuthor = sn?.authorChannelId?.value || null;
    if (!replyAuthor) {
      reasons.push(`REPLY_AUTHOR_MISSING:${parentId}`);
      continue;
    }

    if (parentAuthor && parentAuthor === replyAuthor) {
      reasons.push(`REPLY_TO_OWN_COMMENT_NOT_ALLOWED:${parentId}`);
      continue;
    }

    setDetectedChannel(replyAuthor, "REPLY");

    const wantText = Array.isArray(replyTexts) ? normText(replyTexts[i]) : null;
    if (wantText) {
      const gotText = normText(sn?.textOriginal || "");
      if (gotText !== wantText) {
        reasons.push(`REPLY_TEXT_MISMATCH:${found.id}`);
        continue;
      }
    }

    usedReplyIds.add(found.id);
    usedReplyParentIds.add(parentId);

    actions.push({
      kind: "reply",
      videoId: campaignVideoId,
      commentId: found.id,
      parentId,
      permalink: p.permalink,
      text:
        sn?.textOriginal ||
        (Array.isArray(replyTexts) ? replyTexts[i] : null) ||
        null,
      authorChannelId: replyAuthor,
      publishedAt: sn?.publishedAt || null,
    });
  }

  if (!detectedChannelId) {
    return res.status(422).json({
      code: "CHANNEL_NOT_DETECTED",
      message:
        "Could not detect author channelId from your comment/reply links. Ensure they are public.",
      verification: { reasons },
    });
  }

  // optionally store detected channelId
  try {
    const existing = String(
      user.ytChannelId || user.youtubeChannelId || user.channelId || ""
    ).trim();

    if (!existing || existing === detectedChannelId) {
      await User.updateOne({ userId }, { $set: { ytChannelId: detectedChannelId } });
    } else if (existing !== detectedChannelId) {
      return res.status(422).json({
        code: "YT_CHANNEL_MISMATCH",
        message:
          "Your saved YouTube channel does not match the channel used to comment/reply.",
        verification: { detected: detectedChannelId, saved: existing, reasons },
      });
    }
  } catch {
    // ignore
  }

  const gotComments = actions.filter((a) => a.kind === "comment").length;
  const gotReplies = actions.filter((a) => a.kind === "reply").length;

  const verified =
    reasons.length === 0 &&
    gotComments >= minComments &&
    gotReplies >= minReplies &&
    (!likeRequired || likedAssumed === true);

  const analysisPayload = {
    verified,
    liked: likeRequired ? true : false, // assumed
    channel_id: detectedChannelId,
    comments: actions.filter((a) => a.kind === "comment").map((a) => a.commentId),
    replies: actions.filter((a) => a.kind === "reply").map((a) => a.commentId),
    reasons,
    rules: {
      min_comments: minComments,
      min_replies: minReplies,
      require_like: likeRequired,
    },
  };

  if (!verified) {
    return res.status(422).json({
      code: "VERIFICATION_FAILED",
      message:
        "YouTube verification failed. Ensure comments/replies are public, correct, and from the same channel.",
      verification: analysisPayload,
    });
  }

  // ✅ Reuse check ONLY across OTHER users
  const usedCommentIds = analysisPayload.comments;
  const usedReplyIdsArr = analysisPayload.replies;
  const allUsed = uniq([...usedCommentIds, ...usedReplyIdsArr]);

  const reuseByOtherUser = await Screenshot.findOne({
    linkId,                 // IMPORTANT: Screenshot.linkId is STRING in your model
    verified: true,
    userId: { $ne: String(userId) }, // ✅ exclude current user
    $or: [
      { commentIds: { $in: usedCommentIds } },
      { replyIds: { $in: usedReplyIdsArr } },
      { "actions.commentId": { $in: allUsed } },
      { "analysis.comments": { $in: usedCommentIds } },
      { "analysis.replies": { $in: usedReplyIdsArr } },
    ],
  }).select("userId screenshotId").lean();

  if (reuseByOtherUser) {
    return res.status(409).json({
      code: "ALREADY_USED_BY_OTHER_USER",
      message: "One or more of these comments/replies were already used by another user for this campaign.",
      conflict: {
        byUserId: reuseByOtherUser.userId,
        screenshotId: reuseByOtherUser.screenshotId,
      },
      verification: analysisPayload,
    });
  }

  // Build flattened arrays explicitly (works for both create + update)
  const commentIds = uniq(actions.filter(a => a.kind === "comment").map(a => a.commentId));
  const replyIds = uniq(actions.filter(a => a.kind === "reply").map(a => a.commentId));

  // ✅ Upsert-like behavior: if user's screenshot exists -> UPDATE; else CREATE
  let screenshotDoc;
  try {
    screenshotDoc = await Screenshot.findOne({ userId, linkId });

    if (screenshotDoc) {
      screenshotDoc.videoId = campaignVideoId;
      screenshotDoc.channelId = detectedChannelId;
      screenshotDoc.verified = true;
      screenshotDoc.analysis = analysisPayload;
      screenshotDoc.actions = actions;

      // ensure arrays exist for your unique indexes
      screenshotDoc.commentIds = commentIds;
      screenshotDoc.replyIds = replyIds;

      await screenshotDoc.save(); // triggers schema validation hooks
    } else {
      screenshotDoc = await Screenshot.create({
        userId,
        linkId,
        videoId: campaignVideoId,
        channelId: detectedChannelId,
        verified: true,
        analysis: analysisPayload,
        actions,
        commentIds,
        replyIds,
      });
    }
  } catch (e) {
    if (e?.code === 11000) {
      // index hit (rare after our reuse check, but race conditions happen)
      const key = e?.keyPattern || {};
      if (key.userId && key.linkId) {
        return res.status(409).json({
          code: "USER_ALREADY_VERIFIED",
          message: "This user already submitted verification for this campaign.",
        });
      }
      if (key.linkId && key.commentIds) {
        return res.status(409).json({
          code: "COMMENT_ALREADY_USED",
          message: "This comment was already used for this campaign by someone else.",
        });
      }
      if (key.linkId && key.replyIds) {
        return res.status(409).json({
          code: "REPLY_ALREADY_USED",
          message: "This reply was already used for this campaign by someone else.",
        });
      }
      return res.status(409).json({
        code: "DUPLICATE_VERIFICATION",
        message: "Duplicate verification (unique index hit).",
      });
    }

    return res.status(500).json({
      code: "VERIFICATION_PERSIST_ERROR",
      message: "Could not persist verification. Please try again.",
    });
  }

  // Amounts
  const linkAmount = Number(link.amount) || 0;
  const totalAmount = linkAmount;

  // ✅ Entry upsert-like behavior: same user+link => UPDATE instead of CREATE
  let entry;
  try {
    entry = await Entry.findOne({ type: 1, userId, linkId });
    if (entry) {
      entry.name = String(name).trim();
      entry.worksUnder = String(worksUnder).trim();
      entry.upiId = normalizedReqUpi;
      entry.linkAmount = linkAmount;
      entry.totalAmount = totalAmount;
      entry.screenshotId = screenshotDoc.screenshotId || screenshotDoc._id;
      await entry.save();
    } else {
      entry = await Entry.create({
        entryId: uuidv4(),
        type: 1,
        userId,
        linkId,
        name: String(name).trim(),
        worksUnder: String(worksUnder).trim(),
        upiId: normalizedReqUpi,
        linkAmount,
        totalAmount,
        screenshotId: screenshotDoc.screenshotId || screenshotDoc._id,
      });
    }
  } catch {
    return res.status(500).json({
      code: "ENTRY_PERSIST_ERROR",
      message: "Could not save your entry. Please try again.",
    });
  }

  return res.status(201).json({
    message: screenshotDoc?.isNew ? "User entry submitted" : "User entry updated",
    rules: { minComments, minReplies, requireLike: likeRequired },
    verification: analysisPayload,
    screenshot: {
      screenshotId: screenshotDoc.screenshotId,
      linkId: screenshotDoc.linkId,
      userId: screenshotDoc.userId,
      videoId: screenshotDoc.videoId,
      channelId: screenshotDoc.channelId,
      verified: screenshotDoc.verified,
      actions: screenshotDoc.actions || [],
      createdAt: screenshotDoc.createdAt,
    },
    entry,
  });
});

/* ------------------------------------------------------------------ */
/*  3) READ / LIST                                                    */
/* ------------------------------------------------------------------ */
exports.listEntries = asyncHandler(async (req, res) => {
  const { employeeId, page = 1, limit = 20 } = req.body;
  if (!employeeId)
    return badRequest(res, "VALIDATION_ERROR", "employeeId required");

  const filter = { $or: [{ employeeId }, { worksUnder: employeeId }] };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter),
  ]);

  return res.json({
    entries,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
  });
});

/* ------------------------------------------------------------------ */
/*  4) FETCH single by entryId                                         */
/* ------------------------------------------------------------------ */
exports.getEntryById = asyncHandler(async (req, res) => {
  const { entryId } = req.params;
  const entry = await Entry.findOne({ entryId }).lean();
  if (!entry) return notFound(res, "ENTRY_NOT_FOUND", "Entry not found");
  res.json({ entry });
});

/* ------------------------------------------------------------------ */
/*  5) UPDATE                                                         */
/* ------------------------------------------------------------------ */
exports.updateEntry = asyncHandler(async (req, res) => {
  const { entryId, name, upiId, notes, amount, noOfPersons } = req.body;
  if (!entryId)
    return badRequest(res, "VALIDATION_ERROR", "entryId required");

  const entry = await Entry.findOne({ entryId });
  if (!entry) return notFound(res, "ENTRY_NOT_FOUND", "Entry not found");

  const changes = [];
  const isPaid = entry.status === 1;
  let balanceDelta = 0;
  let debitEmployeeId = null;

  if (entry.type === 0) {
    if (!name || !upiId || amount == null) {
      return badRequest(
        res,
        "VALIDATION_ERROR",
        "name, upiId & amount required for employee entries"
      );
    }
    if (!isValidUpi(String(upiId).trim())) {
      return badRequest(res, "INVALID_UPI", "Invalid UPI format");
    }

    const emp = await Employee.findOne({ employeeId: entry.employeeId });
    if (!emp) return notFound(res, "EMPLOYEE_NOT_FOUND", "Employee not found");

    const trimmedName = String(name).trim();
    if (entry.name !== trimmedName) {
      changes.push({ field: "name", from: entry.name, to: trimmedName });
      entry.name = trimmedName;
    }

    const trimmedUpi = String(upiId).trim();
    if (entry.upiId !== trimmedUpi) {
      changes.push({ field: "upiId", from: entry.upiId, to: trimmedUpi });
      entry.upiId = trimmedUpi;
    }

    const newNotes = String(notes || "").trim();
    if (entry.notes !== newNotes) {
      changes.push({ field: "notes", from: entry.notes, to: newNotes });
      entry.notes = newNotes;
    }

    if (Number(entry.amount) !== Number(amount)) {
      const diff = Number(amount) - Number(entry.amount);
      if (!Number.isFinite(diff)) {
        return badRequest(res, "VALIDATION_ERROR", "amount must be a number");
      }

      changes.push({ field: "amount", from: entry.amount, to: Number(amount) });
      entry.amount = Number(amount);

      if (isPaid) {
        // Already paid out: charge or refund only the difference.
        balanceDelta = -diff;
        debitEmployeeId = entry.employeeId;
      }
    }
  } else {
    if (noOfPersons == null) {
      return badRequest(
        res,
        "VALIDATION_ERROR",
        "noOfPersons required for user entries"
      );
    }

    const newCount = Number(noOfPersons);
    if (!Number.isInteger(newCount) || newCount < 1) {
      return badRequest(
        res,
        "VALIDATION_ERROR",
        "noOfPersons must be a positive whole number"
      );
    }

    if (Number(entry.noOfPersons) !== newCount) {
      changes.push({
        field: "noOfPersons",
        from: entry.noOfPersons,
        to: newCount,
      });
      entry.noOfPersons = newCount;
    }

    const newTotal = newCount * Number(entry.linkAmount || 0);
    if (Number(entry.totalAmount) !== Number(newTotal)) {
      changes.push({
        field: "totalAmount",
        from: entry.totalAmount,
        to: newTotal,
      });

      if (isPaid) {
        // Already paid out: charge or refund only the difference.
        balanceDelta = Number(entry.totalAmount || 0) - newTotal;
        debitEmployeeId = entry.worksUnder;
      }

      entry.totalAmount = newTotal;
    }
  }

  if (!changes.length) {
    return res.json({ message: "No changes detected", entry });
  }

  entry.isUpdated = 1;
  const timestamp = new Date();
  changes.forEach((c) => entry.history.push({ ...c, updatedAt: timestamp }));

  // The edit and any balance correction it implies must land together.
  const session = await mongoose.startSession();
  let newBalance = null;

  try {
    await session.withTransaction(async () => {
      await entry.save({ session });

      if (balanceDelta && debitEmployeeId) {
        newBalance = await applyBalanceDelta({
          employeeId: debitEmployeeId,
          delta: balanceDelta,
          addedBy: entry.userId || entry.employeeId || debitEmployeeId,
          note:
            balanceDelta < 0
              ? `Payout top-up ₹${Math.abs(balanceDelta)} — approved entry ${entryId} edited`
              : `Refund ₹${balanceDelta} — approved entry ${entryId} edited down`,
          session,
        });
      }
    });
  } catch (err) {
    if (err.code === "INSUFFICIENT_BALANCE") {
      return badRequest(
        res,
        "INSUFFICIENT_BALANCE",
        "Insufficient balance to cover the increased amount"
      );
    }
    if (err.code === "EMPLOYEE_NOT_FOUND") {
      return notFound(res, "EMPLOYEE_NOT_FOUND", "Employee to debit not found");
    }
    throw err;
  } finally {
    session.endSession();
  }

  res.json({
    message: "Entry updated",
    entry,
    ...(newBalance !== null ? { newBalance } : {}),
  });
});

/* ------------------------------------------------------------------ */
/*  6) APPROVE / REJECT                                                */
/* ------------------------------------------------------------------ */
exports.setEntryStatus = asyncHandler(async (req, res) => {
  const { entryId, approve } = req.body;
  if (!entryId)
    return badRequest(res, "VALIDATION_ERROR", "entryId required");

  const newStatus = Number(approve);
  if (![0, 1].includes(newStatus)) {
    return badRequest(res, "VALIDATION_ERROR", "approve must be 0 or 1");
  }

  const session = await mongoose.startSession();
  let payload = null;

  try {
    await session.withTransaction(async () => {
      const entry = await Entry.findOne({ entryId }).session(session);
      if (!entry) throw codedError("ENTRY_NOT_FOUND", "Entry not found");

      const prevStatus = entry.status ?? null;

      if (prevStatus === newStatus) {
        payload = {
          message: newStatus ? "Already approved" : "Already rejected",
          entry: { entryId, status: prevStatus },
          alreadyInState: true,
        };
        return;
      }

      const isLegacyLocked =
        newStatus === 1 &&
        !entry.legacyReleasedAt &&
        (entry.isLegacy === true || entry.type == null);

      if (isLegacyLocked) {
        throw codedError(
          "LEGACY_ENTRY_LOCKED",
          "This entry predates the current payout system and needs admin release before it can be approved."
        );
      }

      const { employeeId: targetEmpId, amount } = resolveEntryPayout(entry);
      if (!targetEmpId) {
        throw codedError(
          "INVALID_DEDUCTION",
          "Cannot determine which employee to debit for this entry"
        );
      }
      if (!Number.isFinite(amount) || amount <= 0) {
        throw codedError(
          "INVALID_DEDUCTION",
          "Entry has no valid payout amount"
        );
      }

      // Debit when moving into approved, refund when moving back out of it.
      const wasPaid = prevStatus === 1;
      const delta = newStatus === 1 ? -amount : wasPaid ? amount : 0;

      const updatedEntry = await Entry.findOneAndUpdate(
        { entryId, status: prevStatus },
        {
          $set: { status: newStatus },
          $push: {
            history: {
              field: "status",
              from: prevStatus,
              to: newStatus,
              updatedAt: new Date(),
            },
          },
        },
        { new: true, session }
      );

      if (!updatedEntry) {
        throw codedError(
          "STATUS_CHANGED",
          "This entry was updated by someone else. Refresh and try again."
        );
      }

      const payee = entry.name || entry.userId || entry.employeeId || "";
      const newBalance = await applyBalanceDelta({
        employeeId: targetEmpId,
        delta,
        addedBy: entry.userId || entry.employeeId || targetEmpId,
        note:
          delta < 0
            ? `Payout ₹${amount} — entry ${entryId} (${payee}, ${entry.upiId || "no UPI"})`
            : `Refund ₹${amount} — entry ${entryId} un-approved (${payee})`,
        session,
      });

      payload = {
        message: newStatus ? "Approved" : "Rejected",
        entry: { entryId, status: newStatus },
        ...(delta !== 0
          ? {
              employeeId: targetEmpId,
              [delta < 0 ? "amountDeducted" : "amountRefunded"]: amount,
              newBalance,
            }
          : {}),
      };
    });

    return res.json(payload);
  } catch (err) {
    switch (err.code) {
      case "ENTRY_NOT_FOUND":
        return notFound(res, "ENTRY_NOT_FOUND", err.message);
      case "EMPLOYEE_NOT_FOUND":
        return notFound(res, "EMPLOYEE_NOT_FOUND", "Employee to debit not found");
      case "INVALID_DEDUCTION":
        return badRequest(res, "INVALID_DEDUCTION", err.message);
      case "LEGACY_ENTRY_LOCKED":
        return res
          .status(423)
          .json({ code: "LEGACY_ENTRY_LOCKED", message: err.message });
      case "STATUS_CHANGED":
        return res.status(409).json({ code: "STATUS_CHANGED", message: err.message });
      case "INSUFFICIENT_BALANCE":
        return badRequest(
          res,
          "INSUFFICIENT_BALANCE",
          "Insufficient balance. Please add funds before approval."
        );
      default:
        throw err;
    }
  } finally {
    session.endSession();
  }
});

/* ------------------------------------------------------------------ */
/*  LIST – employee + specific link, POST /entries/listByLink          */
/* ------------------------------------------------------------------ */
exports.listEntriesByLink = asyncHandler(async (req, res) => {
  const { employeeId, linkId, page = 1, limit = 20 } = req.body;
  if (!employeeId)
    return badRequest(res, "VALIDATION_ERROR", "employeeId required");
  if (!linkId) return badRequest(res, "VALIDATION_ERROR", "linkId required");

  const filter = {
    linkId,
    $or: [{ employeeId }, { worksUnder: employeeId }],
  };

  const [entries, total] = await Promise.all([
    Entry.find(filter)
      .sort({ createdAt: -1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean(),
    Entry.countDocuments(filter),
  ]);

  const screenshotIds = entries.map((e) => e.screenshotId).filter(Boolean);

  let screenshotsById = {};
  if (screenshotIds.length) {
    const screenshots = await Screenshot.find({
      screenshotId: { $in: screenshotIds },
    })
      .select("screenshotId userId linkId verified analysis createdAt videoId channelId actions")
      .lean();

    screenshotsById = Object.fromEntries(
      screenshots.map((s) => [String(s.screenshotId), s])
    );
  }

  const entriesWithScreenshots = entries.map((e) => {
    const sid = e.screenshotId ? String(e.screenshotId) : "";
    if (sid && screenshotsById[sid]) {
      return { ...e, screenshot: screenshotsById[sid] };
    }
    return e;
  });

  const agg = await Entry.aggregate([
    { $match: filter },
    {
      $group: {
        _id: null,
        grandTotal: { $sum: { $ifNull: ["$totalAmount", "$amount"] } },
      },
    },
  ]);

  const grandTotal = agg[0]?.grandTotal ?? 0;

  return res.json({
    entries: entriesWithScreenshots,
    total,
    page: Number(page),
    pages: Math.ceil(total / Number(limit)),
    grandTotal,
  });
});


exports.setLikeTaskStatus = asyncHandler(async (req, res) => {
  const { taskId, approve, employeeId } = req.body;

  if (!taskId) {
    return badRequest(res, "VALIDATION_ERROR", "taskId required");
  }

  const newStatus = Number(approve);
  if (![0, 1].includes(newStatus)) {
    return badRequest(res, "VALIDATION_ERROR", "approve must be 0 or 1");
  }

  const session = await mongoose.startSession();

  try {
    let responsePayload = null;

    await session.withTransaction(async () => {
      const task = await LikeTask.findOne({ taskId }).session(session);
      if (!task) {
        const err = new Error("Task not found");
        err.code = "TASK_NOT_FOUND";
        throw err;
      }

      if (task.status === newStatus) {
        responsePayload = {
          message: newStatus === 1 ? "Already approved" : "Already rejected",
          task: {
            taskId: task.taskId,
            status: task.status,
            amount: Number(task.amount || 0),
          },
        };
        return;
      }

      const user = await User.findOne({ userId: task.userId })
        .select("userId name worksUnder")
        .session(session);

      if (!user) {
        const err = new Error("User not found");
        err.code = "USER_NOT_FOUND";
        throw err;
      }

      const targetEmployeeId = String(employeeId || user.worksUnder || "").trim();
      if (!targetEmployeeId) {
        const err = new Error("Employee not found for this task");
        err.code = "EMPLOYEE_NOT_FOUND";
        throw err;
      }

      if (employeeId && String(user.worksUnder || "") !== String(employeeId)) {
        const err = new Error("This task does not belong to the given employee");
        err.code = "EMPLOYEE_MISMATCH";
        throw err;
      }

      let taskAmount = Number(task.amount || 0);

      if (!Number.isFinite(taskAmount) || taskAmount <= 0) {
        const likeLink = await LikeLink.findById(task.likeLinkId)
          .select("amount")
          .lean();

        taskAmount = Number(likeLink?.amount || 0);
        task.amount = taskAmount;
      }

      if (!Number.isFinite(taskAmount) || taskAmount <= 0) {
        const err = new Error("Invalid task amount");
        err.code = "INVALID_TASK_AMOUNT";
        throw err;
      }

      // Debit when moving into approved, refund when moving back out of it.
      const wasPaid = task.status === 1;
      const delta = newStatus === 1 ? -taskAmount : wasPaid ? taskAmount : 0;

      task.status = newStatus;
      await task.save({ session });

      const newBalance = await applyBalanceDelta({
        employeeId: targetEmployeeId,
        delta,
        addedBy: task.userId || targetEmployeeId,
        note:
          delta < 0
            ? `Payout ₹${taskAmount} — like task ${task.taskId} (${user.name || task.userId})`
            : `Refund ₹${taskAmount} — like task ${task.taskId} un-approved (${user.name || task.userId})`,
        session,
      });

      responsePayload = {
        message: newStatus === 1 ? "Like task approved" : "Like task rejected",
        task: {
          taskId: task.taskId,
          status: task.status,
          amount: Number(task.amount || 0),
          userId: task.userId,
          likeLinkId: String(task.likeLinkId),
        },
        ...(delta !== 0
          ? {
              employeeId: targetEmployeeId,
              [delta < 0 ? "amountDeducted" : "amountRefunded"]: taskAmount,
              newBalance,
            }
          : {}),
      };
    });

    return res.json(responsePayload);
  } catch (err) {
    if (err.code === "TASK_NOT_FOUND") {
      return notFound(res, "TASK_NOT_FOUND", "Task not found");
    }
    if (err.code === "USER_NOT_FOUND") {
      return notFound(res, "USER_NOT_FOUND", "User not found");
    }
    if (err.code === "EMPLOYEE_NOT_FOUND") {
      return notFound(res, "EMPLOYEE_NOT_FOUND", "Employee not found");
    }
    if (err.code === "EMPLOYEE_MISMATCH") {
      return badRequest(res, "EMPLOYEE_MISMATCH", "This task does not belong to the given employee");
    }
    if (err.code === "INVALID_TASK_AMOUNT") {
      return badRequest(res, "INVALID_TASK_AMOUNT", "Invalid task amount");
    }
    if (err.code === "INSUFFICIENT_BALANCE") {
      return badRequest(
        res,
        "INSUFFICIENT_BALANCE",
        "Insufficient balance. Please add funds before approval."
      );
    }

    throw err;
  } finally {
    session.endSession();
  }
});