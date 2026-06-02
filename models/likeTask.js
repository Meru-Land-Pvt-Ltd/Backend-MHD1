const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const LikeLink = require("./likeLink");

const EmailSlotSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      lowercase: true,
      trim: true,
    },

    googleSub: {
      type: String,
      required: true,
      trim: true,
    },

    authAt: {
      type: Date,
      required: true,
    },

    authExpiresAt: {
      type: Date,
      required: true,
    },

    screenshotHash: {
      type: String,
      default: null,
    },

    submittedAt: {
      type: Date,
      default: null,
    },

    verified: {
      type: Boolean,
      default: false,
    },

    verificationState: {
      type: String,
      enum: ["pending", "verified", "failed"],
      default: "pending",
    },

    verificationReason: {
      type: String,
      default: "",
    },

    verificationMessage: {
      type: String,
      default: "",
    },

    verifiedBy: {
      type: String,
      default: "",
    },

    videoId: {
      type: String,
      default: "",
    },

    youtubeRating: {
      type: String,
      enum: ["like", "dislike", "none", "unspecified", ""],
      default: "",
    },

    youtubeApiResponse: {
      type: Object,
      default: null,
    },

    accessToken: {
      type: String,
      default: "",
    },

    refreshToken: {
      type: String,
      default: "",
    },

    tokenExpiryDate: {
      type: Date,
      default: null,
    },
  },
  { _id: false }
);

const TaskSchema = new mongoose.Schema(
  {
    taskId: {
      type: String,
      unique: true,
      index: true,
      default: () => uuidv4(),
    },

    userId: {
      type: String,
      ref: "User",
      required: true,
      index: true,
    },

    likeLinkId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LikeLink",
      required: true,
      index: true,
    },

    amount: {
      type: Number,
      default: 0,
    },

    // Existing admin/payment approval status.
    // Keep this numeric field unchanged so old functionality does not break.
    status: {
      type: Number,
      enum: [0, 1],
      default: null,
    },

    maxEmailsAllowed: {
      type: Number,
      default: 5,
    },

    authWindowSeconds: {
      type: Number,
      default: 300,
    },

    emailSlots: {
      type: [EmailSlotSchema],
      default: [],
    },
  },
  { timestamps: true }
);

TaskSchema.index({ userId: 1, likeLinkId: 1 }, { unique: true });
TaskSchema.index({ likeLinkId: 1, createdAt: -1 });
TaskSchema.index({ userId: 1, createdAt: -1 });

TaskSchema.pre("validate", async function (next) {
  try {
    if (!Array.isArray(this.emailSlots)) {
      this.emailSlots = [];
    }

    const maxEmailsAllowed = Math.floor(Number(this.maxEmailsAllowed || 0));

    if (!Number.isFinite(maxEmailsAllowed) || maxEmailsAllowed <= 0) {
      this.maxEmailsAllowed = 1;
    } else {
      this.maxEmailsAllowed = maxEmailsAllowed;
    }

    if (this.emailSlots.length > this.maxEmailsAllowed) {
      return next(
        new Error(`Only ${this.maxEmailsAllowed} different emails are allowed per task`)
      );
    }

    for (const slot of this.emailSlots) {
      slot.email = String(slot.email || "").trim().toLowerCase();

      if (!slot.verificationState) {
        slot.verificationState = slot.verified ? "verified" : "pending";
      }
    }

    const normalized = this.emailSlots.map((x) =>
      String(x.email || "").trim().toLowerCase()
    );

    if (new Set(normalized).size !== normalized.length) {
      return next(new Error("Duplicate email is not allowed in the same task"));
    }

    if (this.likeLinkId) {
      const likeLink = await LikeLink.findById(this.likeLinkId)
        .select("amount")
        .lean();

      if (!likeLink) {
        return next(new Error("Invalid likeLinkId"));
      }

      this.amount = Number(likeLink.amount || 0);
    }

    return next();
  } catch (err) {
    return next(err);
  }
});

module.exports =
  mongoose.models.LikeUploadTask ||
  mongoose.model("LikeUploadTask", TaskSchema);