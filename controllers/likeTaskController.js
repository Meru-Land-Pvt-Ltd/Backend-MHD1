const crypto = require("crypto");
const multer = require("multer");
const mongoose = require("mongoose");
const { google } = require("googleapis");
const Employee = require("../models/Employee");

const Task = require("../models/likeTask");
const LikeLink = require("../models/likeLink");
const User = require("../models/User");

const asyncHandler = (fn) =>
    (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const badRequest = (res, msg) => res.status(400).json({ error: msg });
const notFound = (res, msg) => res.status(404).json({ error: msg });

const AUTH_WINDOW_SECONDS = 120;
const AUTH_WINDOW_MS = AUTH_WINDOW_SECONDS * 1000;

const YOUTUBE_RATING_SCOPE = "https://www.googleapis.com/auth/youtube.force-ssl";

const LIKE_DETECTED_MESSAGE = "Like detected";
const LIKE_NOT_DETECTED_MESSAGE = "Like not detected";
const DUPLICATE_EMAIL_MESSAGE = "Duplicate email detected";

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024 },
});

function getOAuthClient() {
    return new google.auth.OAuth2(
        process.env.GOOGLE_CLIENT_ID,
        process.env.GOOGLE_CLIENT_SECRET,
        process.env.GOOGLE_REDIRECT_URI
    );
}

function normalizeEmail(email = "") {
    return String(email || "").trim().toLowerCase();
}

function signState(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");

    const sig = crypto
        .createHmac("sha256", process.env.GOOGLE_STATE_SECRET)
        .update(body)
        .digest("hex");

    return `${body}.${sig}`;
}

function readState(state) {
    if (!state || !state.includes(".")) {
        throw new Error("Invalid state");
    }

    const [body, sig] = state.split(".");

    const expected = crypto
        .createHmac("sha256", process.env.GOOGLE_STATE_SECRET)
        .update(body)
        .digest("hex");

    if (sig !== expected) {
        throw new Error("State verification failed");
    }

    return JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
}
function isLikeLinkExpired(linkDoc) {
    const expireAt = new Date(linkDoc.createdAt);
    expireAt.setHours(expireAt.getHours() + Number(linkDoc.expireIn || 0));

    return new Date() > expireAt;
}

function getMaxEmailsAllowedFromLikeLink(likeLink) {
    const target = Math.floor(Number(likeLink?.target || 0));
    return Number.isFinite(target) && target > 0 ? target : 1;
}

function serializeTask(taskDoc, likeLinkDoc = null) {
    const now = Date.now();

    const emailSlots = Array.isArray(taskDoc.emailSlots)
        ? taskDoc.emailSlots
        : [];

    const completed = emailSlots.filter((slot) => slot.verified === true);

    const active = emailSlots.find(
        (slot) =>
            slot.verified !== true &&
            slot.authExpiresAt &&
            new Date(slot.authExpiresAt).getTime() > now
    );

    const maxEmailsAllowed = likeLinkDoc
        ? getMaxEmailsAllowedFromLikeLink(likeLinkDoc)
        : Number(taskDoc.maxEmailsAllowed || 1);

    return {
        taskId: taskDoc.taskId,
        userId: taskDoc.userId,
        likeLinkId: String(taskDoc.likeLinkId),
        amount: Number(taskDoc.amount || 0),
        status: taskDoc.status ?? null,
        maxEmailsAllowed,
        completedCount: completed.length,
        completedEmails: completed.map((slot) => slot.email),
        activeEmail: active ? active.email : null,
        activeAuthExpiresAt: active ? active.authExpiresAt : null,
        authWindowSeconds: Number(taskDoc.authWindowSeconds || AUTH_WINDOW_SECONDS),
        locked: completed.length >= maxEmailsAllowed,
    };
}

function escapeHtml(str = "") {
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

function sendPopupError(res, message) {
    res.status(400).set("Content-Type", "text/html");

    res.send(`
<!doctype html>
<html>
  <body style="font-family: Arial, sans-serif; padding: 24px;">
    <h3>Authentication failed</h3>
    <p>${escapeHtml(message)}</p>

    <script>
      try {
        if (window.opener) {
          window.opener.postMessage(
            {
              type: "LIKE_TASK_AUTH_ERROR",
              message: ${JSON.stringify(message)}
            },
            "*"
          );
        }
      } catch (e) {}
    </script>
  </body>
</html>
`);
}

function extractYouTubeVideoId(videoUrl = "") {
    try {
        const url = new URL(String(videoUrl));
        const hostname = url.hostname.replace(/^www\./, "").toLowerCase();

        if (hostname === "youtu.be") {
            return url.pathname.split("/").filter(Boolean)[0] || "";
        }

        if (
            hostname === "youtube.com" ||
            hostname === "m.youtube.com" ||
            hostname === "music.youtube.com"
        ) {
            if (url.pathname === "/watch") {
                return url.searchParams.get("v") || "";
            }

            const parts = url.pathname.split("/").filter(Boolean);

            if (["shorts", "embed", "live"].includes(parts[0]) && parts[1]) {
                return parts[1];
            }
        }

        return "";
    } catch (_) {
        return "";
    }
}

function buildLikeLinkIdMatch(linkIds = []) {
    const stringIds = linkIds.map((id) => String(id)).filter(Boolean);

    const objectIds = stringIds
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));

    return {
        $or: [
            { likeLinkId: { $in: stringIds } },
            { likeLinkId: { $in: objectIds } },
        ],
    };
}

function getYoutubeThumbnail(videoUrl = "") {
    const videoId = extractYouTubeVideoId(videoUrl);

    return videoId
        ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`
        : "";
}

function isFailedLikeSlot(slot = {}) {
    return (
        slot.verificationState === "failed" ||
        slot.verificationMessage === LIKE_NOT_DETECTED_MESSAGE ||
        (
            slot.submittedAt &&
            slot.verified !== true &&
            String(slot.youtubeRating || "").toLowerCase() === "none"
        )
    );
}

function deriveLikeReportStatus(task, likeLink) {
    const maxEmailsAllowed = task
        ? Number(task.maxEmailsAllowed || getMaxEmailsAllowedFromLikeLink(likeLink))
        : getMaxEmailsAllowedFromLikeLink(likeLink);

    const requiredLikes =
        Number.isFinite(maxEmailsAllowed) && maxEmailsAllowed > 0
            ? maxEmailsAllowed
            : 1;

    const emailSlots = Array.isArray(task?.emailSlots) ? task.emailSlots : [];

    const verifiedLikes = emailSlots.filter((slot) => slot.verified === true).length;
    const failedLikes = emailSlots.filter(isFailedLikeSlot).length;
    const accountsLinked = emailSlots.length;

    let status = "Not Started";

    /*
      Reporting rules:
      - Approved: all required likes are verified, e.g. 5/5 or 10/10.
      - Partial: one or more likes failed verification.
      - Pending: verification has started and is still in progress.
        Example: 2/5 verified and 0 failed is Pending.
      - Not Started: no task exists or no linked/authenticated email slots yet.
    */
    if (!task || accountsLinked === 0) {
        status = "Not Started";
    } else if (verifiedLikes >= requiredLikes) {
        status = "Approved";
    } else if (failedLikes > 0) {
        status = "Partial";
    } else {
        status = "Pending";
    }

    return {
        status,
        requiredLikes,
        verifiedLikes,
        failedLikes,
        accountsLinked,
    };
}

function makeEmptyCounts() {
    return {
        approvedCount: 0,
        pendingCount: 0,
        partialCount: 0,
        notStartedCount: 0,
    };
}

function addStatusToCounts(counts, status) {
    if (status === "Approved") {
        counts.approvedCount += 1;
    } else if (status === "Partial") {
        counts.partialCount += 1;
    } else if (status === "Pending") {
        counts.pendingCount += 1;
    } else {
        counts.notStartedCount += 1;
    }
}

function getBonusSlab(averageActiveUsers) {
    const avg = Number(averageActiveUsers || 0);

    if (avg < 90) {
        return {
            applicableBonusSlab: "Below 90 active users",
            bonusRate: 0,
        };
    }

    if (avg <= 120) {
        return {
            applicableBonusSlab: "90 to 120 active users",
            bonusRate: 20,
        };
    }

    return {
        applicableBonusSlab: "Above 120 active users",
        bonusRate: 25,
    };
}

function parseDashboardDateRange(startDate, endDate) {
    if (!startDate) {
        throw new Error("startDate is required");
    }

    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date(startDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
        throw new Error("Invalid date range");
    }

    start.setHours(0, 0, 0, 0);
    end.setHours(23, 59, 59, 999);

    return { start, end };
}

function buildTaskMap(tasks = []) {
    const map = new Map();

    for (const task of tasks) {
        map.set(`${String(task.likeLinkId)}::${String(task.userId)}`, task);
    }

    return map;
}

function getTaskFromMap(taskMap, likeLinkId, userId) {
    return taskMap.get(`${String(likeLinkId)}::${String(userId)}`) || null;
}

async function findVerifiedEmailUsage(likeLinkId, email, excludeTaskMongoId = null) {
    const query = {
        likeLinkId,
        emailSlots: {
            $elemMatch: {
                email: normalizeEmail(email),
                verified: true,
            },
        },
    };

    if (excludeTaskMongoId) {
        query._id = { $ne: excludeTaskMongoId };
    }

    return Task.findOne(query)
        .select("_id taskId userId likeLinkId")
        .lean();
}

function buildOAuthClientFromSlot(slot = {}) {
    const oauth2Client = getOAuthClient();

    const credentials = {};

    if (slot.accessToken) {
        credentials.access_token = slot.accessToken;
    }

    if (slot.refreshToken) {
        credentials.refresh_token = slot.refreshToken;
    }

    if (slot.tokenExpiryDate) {
        credentials.expiry_date = new Date(slot.tokenExpiryDate).getTime();
    }

    if (!credentials.access_token && !credentials.refresh_token) {
        throw new Error("YouTube OAuth token missing for this email");
    }

    oauth2Client.setCredentials(credentials);

    return oauth2Client;
}

async function verifyYoutubeLikeByApi(slot, videoUrl) {
    const videoId = extractYouTubeVideoId(videoUrl);

    if (!videoId) {
        return {
            state: "not_liked",
            liked: false,
            confidence: 0,
            message: LIKE_NOT_DETECTED_MESSAGE,
            reason: "Invalid YouTube video URL",
            videoId: "",
            rating: "none",
            youtubeApiResponse: null,
        };
    }

    const oauth2Client = buildOAuthClientFromSlot(slot);

    const youtube = google.youtube({
        version: "v3",
        auth: oauth2Client,
    });

    let response;

    try {
        response = await youtube.videos.getRating({
            id: videoId,
        });
    } catch (err) {
        console.error("YouTube getRating error:", {
            message: err?.message,
            status: err?.response?.status,
            data: err?.response?.data,
        });

        throw err;
    }

    const rating = String(response.data?.items?.[0]?.rating || "none").toLowerCase();

    const liked = rating === "like";

    return {
        state: liked ? "liked" : "not_liked",
        liked,
        confidence: 1,
        message: liked ? LIKE_DETECTED_MESSAGE : LIKE_NOT_DETECTED_MESSAGE,
        reason: liked
            ? "YouTube API returned rating=like for the authenticated email"
            : `YouTube API returned rating=${rating || "none"} for the authenticated email`,
        videoId,
        rating,
        youtubeApiResponse: response.data || null,
    };
}

async function findOrCreateTask(userId, likeLinkId, likeLink) {
    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    let task = await Task.findOne({ userId, likeLinkId });

    if (!task) {
        task = await Task.create({
            userId,
            likeLinkId,
            maxEmailsAllowed,
            authWindowSeconds: AUTH_WINDOW_SECONDS,
            emailSlots: [],
        });

        return task;
    }

    if (Number(task.maxEmailsAllowed) !== maxEmailsAllowed) {
        task.maxEmailsAllowed = maxEmailsAllowed;
        await task.save();
    }

    return task;
}

function buildYoutubeOpenUrl(videoUrl, email) {
    try {
        let targetUrl = new URL(videoUrl);

        if (targetUrl.hostname === "youtu.be") {
            const videoId = targetUrl.pathname.slice(1);
            targetUrl = new URL(`https://www.youtube.com/watch?v=${videoId}`);
        }

        if (targetUrl.hostname === "youtube.com") {
            targetUrl.hostname = "www.youtube.com";
        }

        const chooserUrl = new URL("https://accounts.google.com/AccountChooser");

        chooserUrl.searchParams.set("continue", targetUrl.toString());
        chooserUrl.searchParams.set("Email", normalizeEmail(email));

        return chooserUrl.toString();
    } catch (e) {
        return String(videoUrl || "");
    }
}

exports.uploadScreenshot = upload.single("screenshot");

exports.getTaskStatuses = asyncHandler(async (req, res) => {
    const { userId } = req.query;

    if (!userId) {
        return badRequest(res, "userId required");
    }

    const tasks = await Task.find({ userId }).lean();

    const likeLinkIds = [
        ...new Set(tasks.map((task) => String(task.likeLinkId)).filter(Boolean)),
    ];

    const likeLinks = await LikeLink.find({ _id: { $in: likeLinkIds } })
        .select("_id target")
        .lean();

    const likeLinkMap = likeLinks.reduce((acc, link) => {
        acc[String(link._id)] = link;
        return acc;
    }, {});

    res.json({
        tasks: tasks.map((task) =>
            serializeTask(task, likeLinkMap[String(task.likeLinkId)] || null)
        ),
    });
});

exports.getOrCreateTask = asyncHandler(async (req, res) => {
    const { userId, likeLinkId } = req.body;

    if (!userId || !likeLinkId) {
        return badRequest(res, "userId and likeLinkId are required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return badRequest(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    if (isLikeLinkExpired(likeLink)) {
        return badRequest(res, "Like task has expired");
    }

    const task = await findOrCreateTask(String(userId), likeLinkId, likeLink);

    res.json({
        task: serializeTask(task, likeLink),
    });
});

exports.startGoogleAuth = asyncHandler(async (req, res) => {
    const { userId, likeLinkId } = req.query;

    if (!userId || !likeLinkId) {
        return sendPopupError(res, "userId and likeLinkId are required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return sendPopupError(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return sendPopupError(res, "Like link not found");
    }

    if (!likeLink.videoUrl) {
        return sendPopupError(res, "videoUrl is missing for this like task");
    }

    if (isLikeLinkExpired(likeLink)) {
        return sendPopupError(res, "Like task has expired");
    }

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    const task = await findOrCreateTask(String(userId), likeLinkId, likeLink);

    const activePending = (task.emailSlots || []).find(
        (x) =>
            !x.verified &&
            x.authExpiresAt &&
            new Date(x.authExpiresAt).getTime() > Date.now()
    );

    if (activePending) {
        return sendPopupError(
            res,
            `Complete the current authenticated email first: ${activePending.email}`
        );
    }

    const completedCount = (task.emailSlots || []).filter((x) => x.verified).length;

    if (completedCount >= maxEmailsAllowed) {
        return sendPopupError(
            res,
            `All ${maxEmailsAllowed} email slots are already completed`
        );
    }

    const state = signState({
        taskId: task.taskId,
        userId: String(userId),
        likeLinkId: String(likeLinkId),
        ts: Date.now(),
    });

    const oauth2Client = getOAuthClient();

    const authUrl = oauth2Client.generateAuthUrl({
        access_type: "offline",
        prompt: "consent select_account",
        scope: ["openid", "email", "profile", YOUTUBE_RATING_SCOPE],
        state,
    });

    res.redirect(authUrl);
});

exports.googleCallback = asyncHandler(async (req, res) => {
    const { code, state } = req.query;

    if (!code || !state) {
        return sendPopupError(res, "Missing Google callback data");
    }

    let parsedState;

    try {
        parsedState = readState(state);
    } catch (err) {
        return sendPopupError(res, err.message || "Invalid state");
    }

    const { taskId, userId, likeLinkId } = parsedState;

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return sendPopupError(res, "Like link not found");
    }

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    const task = await Task.findOne({ taskId, userId, likeLinkId });

    if (!task) {
        return sendPopupError(res, "Task not found");
    }

    task.maxEmailsAllowed = maxEmailsAllowed;

    if (!likeLink.videoUrl) {
        return sendPopupError(res, "videoUrl missing");
    }

    if (isLikeLinkExpired(likeLink)) {
        return sendPopupError(res, "Like task expired");
    }

    const oauth2Client = getOAuthClient();

    const { tokens } = await oauth2Client.getToken(code);

    oauth2Client.setCredentials(tokens);

    const ticket = await oauth2Client.verifyIdToken({
        idToken: tokens.id_token,
        audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();

    const email = normalizeEmail(payload.email);
    const googleSub = String(payload.sub || "").trim();

    if (!email || !googleSub) {
        return sendPopupError(res, "Unable to read authenticated Google account");
    }

    const existingVerified = (task.emailSlots || []).find(
        (x) => normalizeEmail(x.email) === email && x.verified === true
    );

    if (existingVerified) {
        return sendPopupError(res, DUPLICATE_EMAIL_MESSAGE);
    }

    const duplicateVerifiedEmail = await findVerifiedEmailUsage(
        likeLinkId,
        email,
        task._id
    );

    if (duplicateVerifiedEmail) {
        return sendPopupError(res, DUPLICATE_EMAIL_MESSAGE);
    }

    const nowMs = Date.now();

    task.emailSlots = (task.emailSlots || []).filter((slot) => {
        const slotEmail = normalizeEmail(slot.email);
        const isVerified = slot.verified === true;

        const isActivePending =
            !isVerified &&
            slot.authExpiresAt &&
            new Date(slot.authExpiresAt).getTime() > nowMs;

        const isFailed = isFailedLikeSlot(slot);

        return isVerified || isActivePending || isFailed || slotEmail === email;
    });

    const usedEmails = new Set(
        task.emailSlots.map((x) => normalizeEmail(x.email)).filter(Boolean)
    );

    const emailAlreadyExists = usedEmails.has(email);

    if (!emailAlreadyExists && usedEmails.size >= maxEmailsAllowed) {
        return sendPopupError(
            res,
            `Only ${maxEmailsAllowed} different emails are allowed for this task`
        );
    }

    const now = new Date();
    const authExpiresAt = new Date(now.getTime() + AUTH_WINDOW_MS);

    const existingPendingIndex = task.emailSlots.findIndex(
        (x) => normalizeEmail(x.email) === email && x.verified !== true
    );

    const slotData = {
        email,
        googleSub,
        authAt: now,
        authExpiresAt,
        screenshotHash: null,
        submittedAt: null,
        verified: false,
        verificationState: "pending",
        verificationReason: "",
        verificationMessage: "",
        verifiedBy: "youtube_api",
        videoId: "",
        youtubeRating: "",
        youtubeApiResponse: null,
        accessToken: tokens.access_token || "",
        refreshToken: tokens.refresh_token || "",
        tokenExpiryDate: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
    };

    if (existingPendingIndex >= 0) {
        const oldSlot = task.emailSlots[existingPendingIndex];
        const oldRefreshToken = oldSlot?.refreshToken || "";

        task.emailSlots.set(existingPendingIndex, {
            email: slotData.email,
            googleSub: slotData.googleSub,
            authAt: slotData.authAt,
            authExpiresAt: slotData.authExpiresAt,
            screenshotHash: slotData.screenshotHash,
            submittedAt: slotData.submittedAt,
            verified: slotData.verified,
            verificationState: slotData.verificationState,
            verificationReason: slotData.verificationReason,
            verificationMessage: slotData.verificationMessage,
            verifiedBy: slotData.verifiedBy,
            videoId: slotData.videoId,
            youtubeRating: slotData.youtubeRating,
            youtubeApiResponse: slotData.youtubeApiResponse,
            accessToken: slotData.accessToken,
            refreshToken: tokens.refresh_token || oldRefreshToken,
            tokenExpiryDate: slotData.tokenExpiryDate,
        });
    } else {
        task.emailSlots.push(slotData);
    }

    task.markModified("emailSlots");
    await task.save();

    const savedTask = await Task.findOne({ taskId, userId, likeLinkId }).lean();

    const savedActiveSlot = (savedTask?.emailSlots || []).find(
        (slot) =>
            normalizeEmail(slot.email) === email &&
            slot.verified !== true &&
            slot.authExpiresAt &&
            new Date(slot.authExpiresAt).getTime() > Date.now()
    );

    if (!savedActiveSlot) {
        return sendPopupError(
            res,
            "Authentication was not saved. Please authenticate again."
        );
    }

    const frontendOrigin = new URL(process.env.FRONTEND_URL).origin;
    const youtubeOpenUrl = buildYoutubeOpenUrl(likeLink.videoUrl, email);

    res.set("Content-Type", "text/html");

    res.send(`
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Redirecting...</title>
  </head>

  <body style="font-family: Arial, sans-serif; padding: 24px;">
    <p>Authentication successful. Please select your authenticated account to continue to YouTube...</p>

    <script>
      (function () {
        var payload = {
          type: "LIKE_TASK_AUTH_SUCCESS",
          taskId: ${JSON.stringify(task.taskId)},
          likeLinkId: ${JSON.stringify(String(likeLink._id))},
          email: ${JSON.stringify(email)},
          authExpiresAt: ${JSON.stringify(authExpiresAt.toISOString())}
        };

        try {
          if (window.opener) {
            window.opener.postMessage(payload, ${JSON.stringify(frontendOrigin)});
          }
        } catch (e) {}

        window.location.replace(${JSON.stringify(youtubeOpenUrl)});
      })();
    </script>
  </body>
</html>
`);
});

exports.submitScreenshotAndVerify = asyncHandler(async (req, res) => {
    const { userId, likeLinkId, taskId } = req.body;

    if (!userId || !likeLinkId || !taskId) {
        return badRequest(res, "userId, likeLinkId and taskId are required");
    }

    const task = await Task.findOne({ taskId, userId, likeLinkId });

    if (!task) {
        return notFound(res, "Task not found");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    if (!likeLink.videoUrl) {
        return badRequest(res, "videoUrl missing");
    }

    if (isLikeLinkExpired(likeLink)) {
        return badRequest(res, "Like task has expired");
    }

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    if (Number(task.maxEmailsAllowed) !== maxEmailsAllowed) {
        task.maxEmailsAllowed = maxEmailsAllowed;
    }

    const completedCount = (task.emailSlots || []).filter((slot) => slot.verified).length;

    if (completedCount >= maxEmailsAllowed) {
        return badRequest(
            res,
            `All ${maxEmailsAllowed} email slots are already completed`
        );
    }

    const now = Date.now();

    const activeSlotIndex = (task.emailSlots || []).findIndex(
        (x) =>
            !x.verified &&
            x.authExpiresAt &&
            new Date(x.authExpiresAt).getTime() > now
    );

    if (activeSlotIndex < 0) {
        return badRequest(res, "No active authenticated email found or timer expired");
    }

    const activeSlot = task.emailSlots[activeSlotIndex];
    const email = normalizeEmail(activeSlot.email);

    if (!email) {
        return badRequest(res, "Authenticated email missing");
    }

    const alreadyVerifiedInThisTask = (task.emailSlots || []).some(
        (slot, index) =>
            index !== activeSlotIndex &&
            normalizeEmail(slot.email) === email &&
            slot.verified === true
    );

    if (alreadyVerifiedInThisTask) {
        return res.status(400).json({
            error: DUPLICATE_EMAIL_MESSAGE,
            message: DUPLICATE_EMAIL_MESSAGE,
            email,
        });
    }

    const duplicateVerifiedEmail = await findVerifiedEmailUsage(
        likeLinkId,
        email,
        task._id
    );

    if (duplicateVerifiedEmail) {
        return res.status(400).json({
            error: DUPLICATE_EMAIL_MESSAGE,
            message: DUPLICATE_EMAIL_MESSAGE,
            email,
        });
    }

    let verification;

    try {
        verification = await verifyYoutubeLikeByApi(activeSlot, likeLink.videoUrl);
    } catch (err) {
        verification = {
            state: "not_liked",
            liked: false,
            confidence: 0,
            message: LIKE_NOT_DETECTED_MESSAGE,
            reason: err.message || "Unable to verify like with YouTube API",
            videoId: "",
            rating: "none",
            youtubeApiResponse: null,
        };
    }

    if (!verification.liked) {
        task.emailSlots[activeSlotIndex].email = email;
        task.emailSlots[activeSlotIndex].submittedAt = new Date();
        task.emailSlots[activeSlotIndex].verified = false;
        task.emailSlots[activeSlotIndex].verificationState = "failed";
        task.emailSlots[activeSlotIndex].verificationReason = verification.reason;
        task.emailSlots[activeSlotIndex].verificationMessage = LIKE_NOT_DETECTED_MESSAGE;
        task.emailSlots[activeSlotIndex].verifiedBy = "youtube_api";
        task.emailSlots[activeSlotIndex].videoId = verification.videoId || "";
        task.emailSlots[activeSlotIndex].youtubeRating = verification.rating || "none";
        task.emailSlots[activeSlotIndex].youtubeApiResponse =
            verification.youtubeApiResponse || null;
        task.emailSlots[activeSlotIndex].authExpiresAt = new Date();

        task.emailSlots[activeSlotIndex].accessToken = "";
        task.emailSlots[activeSlotIndex].refreshToken = "";
        task.emailSlots[activeSlotIndex].tokenExpiryDate = null;

        task.markModified("emailSlots");
        await task.save();

        return res.status(400).json({
            error: LIKE_NOT_DETECTED_MESSAGE,
            message: LIKE_NOT_DETECTED_MESSAGE,
            email,
            task: serializeTask(task, likeLink),
            verification: {
                state: verification.state,
                liked: verification.liked,
                confidence: verification.confidence,
                message: verification.message,
                reason: verification.reason,
                videoId: verification.videoId,
                rating: verification.rating,
            },
        });
    }

    task.emailSlots[activeSlotIndex].email = email;
    task.emailSlots[activeSlotIndex].submittedAt = new Date();
    task.emailSlots[activeSlotIndex].verified = true;
    task.emailSlots[activeSlotIndex].verificationState = "verified";
    task.emailSlots[activeSlotIndex].verificationReason = verification.reason;
    task.emailSlots[activeSlotIndex].verificationMessage = LIKE_DETECTED_MESSAGE;
    task.emailSlots[activeSlotIndex].verifiedBy = "youtube_api";
    task.emailSlots[activeSlotIndex].videoId = verification.videoId || "";
    task.emailSlots[activeSlotIndex].youtubeRating = verification.rating || "like";
    task.emailSlots[activeSlotIndex].youtubeApiResponse =
        verification.youtubeApiResponse || null;
    task.emailSlots[activeSlotIndex].authExpiresAt = new Date();

    task.emailSlots[activeSlotIndex].accessToken = "";
    task.emailSlots[activeSlotIndex].refreshToken = "";
    task.emailSlots[activeSlotIndex].tokenExpiryDate = null;

    task.markModified("emailSlots");

    await task.save();

    const serialized = serializeTask(task, likeLink);

    return res.json({
        message: LIKE_DETECTED_MESSAGE,
        email,
        task: serialized,
        verification: {
            state: verification.state,
            liked: verification.liked,
            confidence: verification.confidence,
            message: LIKE_DETECTED_MESSAGE,
            reason: verification.reason,
            videoId: verification.videoId,
            rating: verification.rating,
        },
    });
});

exports.getLikeLinkEntries = asyncHandler(async (req, res) => {
    const { linkId } = req.body;

    if (!linkId) {
        return badRequest(res, "linkId is required");
    }

    if (!mongoose.Types.ObjectId.isValid(linkId)) {
        return badRequest(res, "Invalid linkId");
    }

    const likeLink = await LikeLink.findById(linkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    const tasks = await Task.find({ likeLinkId: linkId })
        .sort({ createdAt: -1 })
        .lean();

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);

    const userIds = [...new Set(tasks.map((t) => t.userId).filter(Boolean))];

    const users = await User.find({ userId: { $in: userIds } })
        .select("userId name email phone")
        .lean();

    const userMap = users.reduce((acc, user) => {
        acc[user.userId] = user;
        return acc;
    }, {});

    const entries = tasks.map((task) => {
        const emailSlots = Array.isArray(task.emailSlots) ? task.emailSlots : [];

        const verifiedSlots = emailSlots.filter((slot) => slot.verified);
        const pendingSlots = emailSlots.filter((slot) => !slot.verified);

        return {
            _id: task._id,
            taskId: task.taskId,
            userId: task.userId,
            user: userMap[task.userId] || null,
            likeLinkId: task.likeLinkId,
            amount: Number(task.amount || 0),
            status: task.status ?? null,
            maxEmailsAllowed,
            authWindowSeconds: task.authWindowSeconds,
            completedCount: verifiedSlots.length,
            pendingCount: pendingSlots.length,
            emailSlots: emailSlots.map((slot) => ({
                email: slot.email,
                googleSub: slot.googleSub,
                authAt: slot.authAt,
                authExpiresAt: slot.authExpiresAt,
                submittedAt: slot.submittedAt,
                verified: slot.verified,
                verificationState: slot.verificationState || (slot.verified ? "verified" : "pending"),
                verificationReason: slot.verificationReason,
                verificationMessage: slot.verificationMessage,
                verifiedBy: slot.verifiedBy,
                videoId: slot.videoId,
                youtubeRating: slot.youtubeRating,
                youtubeApiResponse: slot.youtubeApiResponse,
            })),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    });

    res.json({
        likeLink: {
            _id: likeLink._id,
            title: likeLink.title,
            videoUrl: likeLink.videoUrl,
            target: likeLink.target,
            amount: likeLink.amount,
            expireIn: likeLink.expireIn,
            requireLike: likeLink.requireLike,
            createdAt: likeLink.createdAt,
        },
        totalEntries: entries.length,
        entries,
    });
});



exports.getEmployeeLikeLinkEntries = asyncHandler(async (req, res) => {
    const { linkId, employeeId } = req.body;

    const page = Math.max(parseInt(req.body.page || 1, 10), 1);
    const limit = Math.min(Math.max(parseInt(req.body.limit || 10, 10), 1), 100);
    const skip = (page - 1) * limit;

    if (!linkId) {
        return badRequest(res, "linkId is required");
    }

    if (!employeeId) {
        return badRequest(res, "employeeId is required");
    }

    if (!mongoose.Types.ObjectId.isValid(linkId)) {
        return badRequest(res, "Invalid linkId");
    }

    const likeLink = await LikeLink.findById(linkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    const maxEmailsAllowed = getMaxEmailsAllowedFromLikeLink(likeLink);
    const linkObjectId = new mongoose.Types.ObjectId(linkId);

    const pipeline = [
        {
            $match: {
                likeLinkId: linkObjectId,
            },
        },
        {
            $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "userId",
                as: "user",
            },
        },
        {
            $unwind: {
                path: "$user",
                preserveNullAndEmptyArrays: false,
            },
        },
        {
            $match: {
                "user.worksUnder": String(employeeId),
            },
        },
        {
            $sort: {
                createdAt: -1,
            },
        },
        {
            $facet: {
                metadata: [
                    {
                        $count: "totalEntries",
                    },
                ],
                data: [
                    {
                        $skip: skip,
                    },
                    {
                        $limit: limit,
                    },
                    {
                        $project: {
                            _id: 1,
                            taskId: 1,
                            userId: 1,
                            likeLinkId: 1,
                            amount: 1,
                            status: 1,
                            maxEmailsAllowed: 1,
                            authWindowSeconds: 1,
                            emailSlots: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            user: {
                                userId: "$user.userId",
                                name: "$user.name",
                                email: "$user.email",
                                phone: "$user.phone",
                                worksUnder: "$user.worksUnder",
                            },
                        },
                    },
                ],
            },
        },
    ];

    const result = await Task.aggregate(pipeline);

    const rows = result?.[0]?.data || [];
    const totalEntries = result?.[0]?.metadata?.[0]?.totalEntries || 0;

    const entries = rows.map((task) => {
        const emailSlots = Array.isArray(task.emailSlots) ? task.emailSlots : [];

        const verifiedSlots = emailSlots.filter((slot) => slot.verified);
        const pendingSlots = emailSlots.filter((slot) => !slot.verified);

        return {
            _id: task._id,
            taskId: task.taskId,
            userId: task.userId,
            user: task.user || null,
            likeLinkId: task.likeLinkId,
            amount: Number(task.amount || 0),
            status: task.status ?? null,
            maxEmailsAllowed,
            authWindowSeconds: task.authWindowSeconds,
            completedCount: verifiedSlots.length,
            pendingCount: pendingSlots.length,
            emailSlots: emailSlots.map((slot) => ({
                email: slot.email,
                googleSub: slot.googleSub,
                authAt: slot.authAt,
                authExpiresAt: slot.authExpiresAt,
                submittedAt: slot.submittedAt,
                verified: slot.verified,
                verificationState: slot.verificationState || (slot.verified ? "verified" : "pending"),
                verificationReason: slot.verificationReason,
                verificationMessage: slot.verificationMessage,
                verifiedBy: slot.verifiedBy,
                videoId: slot.videoId,
                youtubeRating: slot.youtubeRating,
                youtubeApiResponse: slot.youtubeApiResponse,
            })),
            createdAt: task.createdAt,
            updatedAt: task.updatedAt,
        };
    });

    const totalPages = Math.ceil(totalEntries / limit);

    res.json({
        likeLink: {
            _id: likeLink._id,
            title: likeLink.title,
            videoUrl: likeLink.videoUrl,
            target: likeLink.target,
            amount: likeLink.amount,
            expireIn: likeLink.expireIn,
            requireLike: likeLink.requireLike,
            createdAt: likeLink.createdAt,
        },
        pagination: {
            page,
            limit,
            totalEntries,
            totalPages,
            hasNextPage: page < totalPages,
            hasPrevPage: page > 1,
        },
        entries,
    });
});

exports.getLikeTaskVideoList = asyncHandler(async (_req, res) => {
    const employees = await Employee.find({ isApproved: 1 })
        .select("employeeId name email")
        .sort({ name: 1 })
        .lean();

    const employeeIds = employees.map((emp) => String(emp.employeeId));

    const users = await User.find({ worksUnder: { $in: employeeIds } })
        .select("userId name email phone worksUnder")
        .lean();

    const likeLinks = await LikeLink.find()
        .select("title videoUrl createdBy createdAt target amount expireIn requireLike")
        .sort({ createdAt: -1 })
        .lean();

    const likeLinkIds = likeLinks.map((link) => link._id);
    const userIds = users.map((user) => user.userId);

    const tasks =
        likeLinkIds.length && userIds.length
            ? await Task.find({
                  ...buildLikeLinkIdMatch(likeLinkIds),
                  userId: { $in: userIds },
              }).lean()
            : [];

    const taskMap = buildTaskMap(tasks);

    const videos = likeLinks.map((likeLink) => {
        const counts = makeEmptyCounts();

        for (const user of users) {
            const task = getTaskFromMap(taskMap, likeLink._id, user.userId);
            const derived = deriveLikeReportStatus(task, likeLink);

            addStatusToCounts(counts, derived.status);
        }

        const expireAt = new Date(likeLink.createdAt);
        expireAt.setHours(expireAt.getHours() + Number(likeLink.expireIn || 0));

        return {
            likeLinkId: String(likeLink._id),
            videoTitle: likeLink.title,
            videoUrl: likeLink.videoUrl,
            thumbnail: getYoutubeThumbnail(likeLink.videoUrl),
            totalTaskCount: users.length,
            totalEmployeesWorking: employees.length,
            approvedCount: counts.approvedCount,
            pendingCount: counts.pendingCount,
            partialCount: counts.partialCount,
            notStartedCount: counts.notStartedCount,
            createdAt: likeLink.createdAt,
            expireAt,
        };
    });

    return res.json({
        total: videos.length,
        videos,
    });
});

exports.getLikeTaskEmployeesByVideo = asyncHandler(async (req, res) => {
    const { likeLinkId } = req.body;

    if (!likeLinkId) {
        return badRequest(res, "likeLinkId is required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return badRequest(res, "Invalid likeLinkId");
    }

    const likeLink = await LikeLink.findById(likeLinkId).lean();

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    const employees = await Employee.find({ isApproved: 1 })
        .select("employeeId name email")
        .sort({ name: 1 })
        .lean();

    const employeeIds = employees.map((emp) => String(emp.employeeId));

    const users = await User.find({ worksUnder: { $in: employeeIds } })
        .select("userId name email phone worksUnder")
        .lean();

    const userIds = users.map((user) => user.userId);

    const tasks = userIds.length
        ? await Task.find({
              ...buildLikeLinkIdMatch([likeLink._id]),
              userId: { $in: userIds },
          }).lean()
        : [];

    const taskMap = buildTaskMap(tasks);

    const usersByEmployee = users.reduce((acc, user) => {
        const key = String(user.worksUnder || "");

        if (!acc[key]) {
            acc[key] = [];
        }

        acc[key].push(user);
        return acc;
    }, {});

    const employeeRows = employees.map((employee) => {
        const employeeUsers = usersByEmployee[String(employee.employeeId)] || [];
        const counts = makeEmptyCounts();

        for (const user of employeeUsers) {
            const task = getTaskFromMap(taskMap, likeLink._id, user.userId);
            const derived = deriveLikeReportStatus(task, likeLink);

            addStatusToCounts(counts, derived.status);
        }

        return {
            employeeId: employee.employeeId,
            employeeName: employee.name,
            email: employee.email,
            totalUsers: employeeUsers.length,
            approvedCount: counts.approvedCount,
            pendingCount: counts.pendingCount,
            partialCount: counts.partialCount,
            notStartedCount: counts.notStartedCount,
        };
    });

    return res.json({
        likeLink: {
            likeLinkId: String(likeLink._id),
            videoTitle: likeLink.title,
            videoUrl: likeLink.videoUrl,
            thumbnail: getYoutubeThumbnail(likeLink.videoUrl),
        },
        total: employeeRows.length,
        employees: employeeRows,
    });
});

exports.getLikeTaskUsersByEmployee = asyncHandler(async (req, res) => {
    const { likeLinkId, employeeId } = req.body;

    if (!likeLinkId) {
        return badRequest(res, "likeLinkId is required");
    }

    if (!employeeId) {
        return badRequest(res, "employeeId is required");
    }

    if (!mongoose.Types.ObjectId.isValid(likeLinkId)) {
        return badRequest(res, "Invalid likeLinkId");
    }

    const [likeLink, employee] = await Promise.all([
        LikeLink.findById(likeLinkId).lean(),
        Employee.findOne({ employeeId: String(employeeId) })
            .select("employeeId name email")
            .lean(),
    ]);

    if (!likeLink) {
        return notFound(res, "Like link not found");
    }

    if (!employee) {
        return notFound(res, "Employee not found");
    }

    const users = await User.find({ worksUnder: String(employeeId) })
        .select("userId name email phone worksUnder")
        .sort({ name: 1 })
        .lean();

    const userIds = users.map((user) => user.userId);

    const tasks = userIds.length
        ? await Task.find({
              ...buildLikeLinkIdMatch([likeLink._id]),
              userId: { $in: userIds },
          }).lean()
        : [];

    const taskMap = buildTaskMap(tasks);

    const userRows = users.map((user) => {
        const task = getTaskFromMap(taskMap, likeLink._id, user.userId);
        const derived = deriveLikeReportStatus(task, likeLink);

        return {
            userId: user.userId,
            userName: user.name,
            email: user.email,
            phone: user.phone,
            accountsLinked: derived.accountsLinked,
            verificationCount: derived.verifiedLikes,
            requiredLikes: derived.requiredLikes,
            failedLikes: derived.failedLikes,
            status: derived.status,
        };
    });

    const statusRank = {
        Approved: 0,
        Partial: 1,
        Pending: 2,
        "Not Started": 3,
    };

    userRows.sort((a, b) => {
        const aRank = statusRank[a.status] ?? 4;
        const bRank = statusRank[b.status] ?? 4;

        if (aRank !== bRank) {
            return aRank - bRank;
        }

        return String(a.userName || a.email || a.userId || "").localeCompare(
            String(b.userName || b.email || b.userId || "")
        );
    });

    return res.json({
        likeLink: {
            likeLinkId: String(likeLink._id),
            videoTitle: likeLink.title,
            videoUrl: likeLink.videoUrl,
            thumbnail: getYoutubeThumbnail(likeLink.videoUrl),
        },
        employee: {
            employeeId: employee.employeeId,
            employeeName: employee.name,
            email: employee.email,
        },
        total: userRows.length,
        users: userRows,
    });
});

exports.getLikeTaskEmployeePerformance = asyncHandler(async (req, res) => {
    const { employeeId, startDate, endDate } = req.body;

    if (!employeeId) {
        return badRequest(res, "employeeId is required");
    }

    let range;

    try {
        range = parseDashboardDateRange(startDate, endDate);
    } catch (err) {
        return badRequest(res, err.message || "Invalid date range");
    }

    const employee = await Employee.findOne({ employeeId: String(employeeId) })
        .select("employeeId name email")
        .lean();

    if (!employee) {
        return notFound(res, "Employee not found");
    }

    const likeLinks = await LikeLink.find({
        createdAt: {
            $gte: range.start,
            $lte: range.end,
        },
    })
        .select("title videoUrl createdAt target amount expireIn requireLike")
        .sort({ createdAt: 1 })
        .lean();

    const users = await User.find({ worksUnder: String(employeeId) })
        .select("userId name worksUnder")
        .lean();

    const userIds = users.map((user) => user.userId);
    const likeLinkIds = likeLinks.map((link) => link._id);

    const tasks =
        likeLinkIds.length && userIds.length
            ? await Task.find({
                  ...buildLikeLinkIdMatch(likeLinkIds),
                  userId: { $in: userIds },
              }).lean()
            : [];

    const taskMap = buildTaskMap(tasks);

    let totalApprovedActiveUsers = 0;

    const videoBreakdown = likeLinks.map((likeLink) => {
        let approvedActiveUsers = 0;

        for (const user of users) {
            const task = getTaskFromMap(taskMap, likeLink._id, user.userId);
            const derived = deriveLikeReportStatus(task, likeLink);

            if (derived.status === "Approved") {
                approvedActiveUsers += 1;
            }
        }

        totalApprovedActiveUsers += approvedActiveUsers;

        return {
            likeLinkId: String(likeLink._id),
            videoTitle: likeLink.title,
            videoUrl: likeLink.videoUrl,
            thumbnail: getYoutubeThumbnail(likeLink.videoUrl),
            approvedActiveUsers,
        };
    });

    const totalVideos = likeLinks.length;

    const averageActiveUsers =
        totalVideos > 0
            ? Number((totalApprovedActiveUsers / totalVideos).toFixed(2))
            : 0;

    const bonus = getBonusSlab(averageActiveUsers);
    const totalBonus = Number((averageActiveUsers * bonus.bonusRate).toFixed(2));

    return res.json({
        employee: {
            employeeId: employee.employeeId,
            employeeName: employee.name,
            email: employee.email,
        },
        period: {
            startDate: range.start,
            endDate: range.end,
        },
        totalVideos,
        totalApprovedActiveUsers,
        averageActiveUsers,
        applicableBonusSlab: bonus.applicableBonusSlab,
        bonusRate: bonus.bonusRate,
        totalBonus,
        videoBreakdown,
    });
});