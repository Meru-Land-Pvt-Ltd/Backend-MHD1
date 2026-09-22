// models/Screenshot.js  (API verification version)
const mongoose = require('mongoose');
const { v4: uuidv4 } = require('uuid');
const { buildDuplicateTextKey } = require('../utils/textNormalization');

const actionSchema = new mongoose.Schema(
  {
    kind: { type: String, enum: ['comment', 'reply'], required: true },

    // campaign video
    videoId: { type: String, required: true },

    // for top-level comment, commentId is the thread id (same as lc without dot)
    // for reply, commentId is the reply comment resource id returned by API (if found)
    commentId: { type: String, required: true },

    // reply-only: parent top-level comment id
    parentId: { type: String },

    // user-submitted permalink
    permalink: { type: String, required: true },

    // verified text returned by YouTube (frontend text is not trusted for duplicate checks)
    text: { type: String },

    // author channel id from API
    authorChannelId: { type: String },

    publishedAt: { type: String }
  },
  { _id: false }
);

const screenshotSchema = new mongoose.Schema(
  {
    screenshotId: { type: String, default: uuidv4, unique: true },

    userId: { type: String, ref: 'User', required: true },
    linkId: { type: String, ref: 'Link', required: true },

    // campaign video id
    videoId: { type: String, required: true },

    // the channel we verified against (to prevent fraud)
    channelId: { type: String, required: true },

    verified: { type: Boolean, required: true, default: false },
    analysis: { type: mongoose.Schema.Types.Mixed },

    // flattened ids for uniqueness enforcement
    commentIds: [{ type: String }],
    replyIds: [{ type: String }],

    // flattened normalized text keys for same-campaign uniqueness enforcement
    commentTextKeys: [{ type: String }],
    replyTextKeys: [{ type: String }],

    // Only documents written by the new duplicate-text logic participate in
    // the text-key unique indexes. This avoids startup/index failures caused
    // by historical records that may already contain duplicate wording.
    textUniquenessVersion: { type: Number },

    // store all verified actions
    actions: { type: [actionSchema], required: true },

    createdAt: { type: Date, default: Date.now }
  },
  { minimize: true }
);

// Normalize + enforce consistent doc
screenshotSchema.pre('validate', function (next) {
  try {
    if (!this.videoId) return next(new Error('videoId required'));
    if (!this.channelId) return next(new Error('channelId required'));

    if (!Array.isArray(this.actions) || this.actions.length < 1) {
      return next(new Error('actions required'));
    }

    // derive IDs and normalized text keys from verified actions
    const commentIds = [];
    const replyIds = [];
    const commentTextKeys = [];
    const replyTextKeys = [];

    for (const a of this.actions) {
      const textKey = buildDuplicateTextKey(a.text);

      if (a.kind === 'comment') {
        commentIds.push(a.commentId);
        if (textKey) commentTextKeys.push(textKey);
      }
      if (a.kind === 'reply') {
        replyIds.push(a.commentId);
        if (textKey) replyTextKeys.push(textKey);
      }
    }

    this.commentIds = [...new Set(commentIds)];
    this.replyIds = [...new Set(replyIds)];
    this.commentTextKeys = [...new Set(commentTextKeys)];
    this.replyTextKeys = [...new Set(replyTextKeys)];
    this.textUniquenessVersion = 1;

    return next();
  } catch (e) {
    return next(e);
  }
});

// only 1 verification per user per campaign link (adjust if you want multiple attempts)
screenshotSchema.index({ userId: 1, linkId: 1 }, { unique: true });

// prevent reusing the SAME comment/reply on same campaign link across different users
// (compound unique with array works: (linkId, commentId) must be unique)
screenshotSchema.index(
  { linkId: 1, commentIds: 1 },
  { unique: true, partialFilterExpression: { verified: true } }
);
screenshotSchema.index(
  { linkId: 1, replyIds: 1 },
  { unique: true, partialFilterExpression: { verified: true } }
);

// prevent reusing the SAME normalized comment/reply text on the same campaign.
// Historical records are excluded until they are rewritten with version=1;
// controller-level legacy scanning still blocks new submissions against them.
screenshotSchema.index(
  { linkId: 1, commentTextKeys: 1 },
  {
    unique: true,
    partialFilterExpression: { verified: true, textUniquenessVersion: 1 }
  }
);
screenshotSchema.index(
  { linkId: 1, replyTextKeys: 1 },
  {
    unique: true,
    partialFilterExpression: { verified: true, textUniquenessVersion: 1 }
  }
);

module.exports = mongoose.model('Screenshot', screenshotSchema);
