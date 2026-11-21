/**
 * What a speaker tag on a transcript line can be used for.
 *
 * Live lines are tagged by the speech service (audio/speech/live/source_labels.py):
 *   "you"     the person who recorded the meeting: their microphone was sounding and the shared audio was not
 *   "others"  the people on the shared tab or system audio: possibly several different people
 *   (none)    no clear answer; the line is marked uncertain
 * Lines recorded before that, and lectures through the batch pipeline, carry placeholder tags such as "speaker_00".
 *
 * A tag says where the sound came from. It becomes an owner (the person an action is assigned to) only when it names
 * ONE person, and only "you" does. "others" is a crowd, and a placeholder is not a name: assigning an action to
 * either would put a made-up owner in the record.
 */

export const SPEAKER_YOU = 'you'
export const SPEAKER_OTHERS = 'others'

/** Whether this tag names one real person, so that a first-person line from them may make them an owner. */
export function namesOnePerson(label) {
  return label === SPEAKER_YOU
}
