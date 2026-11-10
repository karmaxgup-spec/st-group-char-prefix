// Group Chat Character Prompt Prefix
//
// The built-in Image Generation extension only applies a character's saved
// "character prompt prefix" in single-character chats. In group chats the
// lookup returns nothing, so the prefix is silently dropped.
//
// This extension fills that gap. It tracks which group member is currently
// replying (GROUP_MEMBER_DRAFTED / GROUP_WRAPPER_FINISHED), then, when an image
// is generated (manually, via a message, or via a tool call from the model),
// prepends that member's saved prefix to the prompt. The prefix is added at
// SD_PROMPT_PROCESSING, before the core combines the global prefix.
//
// It does nothing outside group chats, so single-character behaviour is
// unchanged and nothing is applied twice.

import { eventSource, event_types } from '../../../../script.js';
import { getContext, extension_settings } from '../../../extensions.js';

const MODULE_NAME = 'st-group-char-prefix';

// Generation modes where the image shows a character or the scene the speaker
// is in. Tool calls from the model usually arrive as FREE (or TOOL), so both are
// included when we know who is speaking.
const SPEAKER_MODES = new Set([
    -2, // TOOL: model-initiated image via function call
    -1, // MESSAGE
    0,  // CHARACTER
    5,  // FACE
    6,  // FREE
    8,  // CHARACTER_MULTIMODAL
    10, // FACE_MULTIMODAL
    11, // FREE_EXTENDED
]);

// Without a known speaker, only character-depicting modes fall back to the
// message-based lookup. Manual free prompts stay untouched.
const CHARACTER_MODES = new Set([-1, 0, 5, 8, 10]);

// Character ID of the group member currently generating, or null between turns.
let currentSpeakerIndex = null;

/**
 * Strips the file extension from an avatar filename to get the settings key
 * the Image Generation extension uses for character prompts.
 * @param {string|undefined|null} avatar
 * @returns {string|null}
 */
function avatarKey(avatar) {
    if (!avatar) return null;
    return String(avatar).replace(/\.[^/.]+$/, '') || null;
}

/**
 * Finds the group member a chat message belongs to.
 * @param {object} message Chat message object
 * @param {object} context SillyTavern context
 * @returns {object|null} Character entry from the context, or null
 */
function findCharacterForMessage(message, context) {
    if (!message || message.is_user || message.is_system) return null;

    const byAvatar = message.original_avatar
        ? context.characters.find(c => c?.avatar === message.original_avatar)
        : null;
    if (byAvatar) return byAvatar;

    if (message.name) {
        return context.characters.find(c => c?.name === message.name) ?? null;
    }

    return null;
}

/**
 * Picks the most recent non-user message in the chat.
 * @param {object} context SillyTavern context
 * @returns {object|null}
 */
function lastCharacterMessage(context) {
    const chat = context.chat || [];
    for (let i = chat.length - 1; i >= 0; i--) {
        if (!chat[i].is_user && !chat[i].is_system) return chat[i];
    }
    return null;
}

/**
 * Returns the saved character prompt prefix for the image's subject.
 * @param {object} eventData Event payload from the Image Generation extension
 * @returns {string} Prefix text, or an empty string when none applies
 */
function resolveCharacterPrefix(eventData) {
    const context = getContext();

    // Only group chats need this. Single-character chats are handled by the core.
    if (!context.groupId) return '';

    let character = null;

    if (currentSpeakerIndex !== null) {
        // A group member is replying right now (covers tool-call images).
        if (!SPEAKER_MODES.has(eventData.generationType)) return '';
        character = context.characters[currentSpeakerIndex] ?? null;
    } else {
        if (!CHARACTER_MODES.has(eventData.generationType)) return '';
        const message = eventData.message ?? lastCharacterMessage(context);
        character = findCharacterForMessage(message, context);
    }

    const key = avatarKey(character?.avatar);
    if (!key) return '';

    const settings = extension_settings?.sd?.character_prompts ?? {};
    return String(settings[key] ?? '').trim();
}

eventSource.on(event_types.GROUP_MEMBER_DRAFTED, (chId) => {
    const index = Number(chId);
    currentSpeakerIndex = Number.isInteger(index) ? index : null;
});

eventSource.on(event_types.GROUP_WRAPPER_FINISHED, () => {
    currentSpeakerIndex = null;
});

eventSource.on(event_types.SD_PROMPT_PROCESSING, (eventData) => {
    try {
        const prefix = resolveCharacterPrefix(eventData);
        if (!prefix) return;

        const current = String(eventData.prompt ?? '');

        // Avoid double-applying if the prefix is already present.
        if (current.includes(prefix)) return;

        eventData.prompt = current ? `${prefix}, ${current}` : prefix;
        console.debug(`[${MODULE_NAME}] Applied group character prefix`);
    } catch (error) {
        // Never break image generation over a prefix problem.
        console.debug(`[${MODULE_NAME}] Skipped prefix:`, error);
    }
});
