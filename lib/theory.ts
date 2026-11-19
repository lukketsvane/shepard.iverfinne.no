/**
 * "How it works": the theory behind the instrument, in the order a curious listener needs it.
 * Rendered by the UI; plain text, one string per paragraph. `$math` paragraphs are shown as formulas.
 */

export interface TheorySection {
  id: string;
  title: string;
  body: string[];
}

export const THEORY: TheorySection[] = [
  {
    id: 'one-trick',
    title: 'One trick, two illusions',
    body: [
      'A Shepard tone is a chord of sine waves exactly one octave apart, played under a fixed bell-shaped volume curve over frequency: loud in the middle, silent at the very low and very high ends. Slide every sine up a little and the chord seems to rise. Slide it up a whole octave and every sine has taken its upper neighbour’s place: the chord is identical to where it started, so the rise can go on forever.',
      'The Risset rhythm is the same object four to eight octaves lower, where repetition is heard as tempo instead of pitch. Instead of sine waves we stack copies of a groove, each playing at twice the tempo of the one below. All copies accelerate together. A fixed volume curve over tempo fades the fastest copy out while a new slowest copy fades in. After one doubling, the stack is identical to where it started.',
      'Jean-Claude Risset built both: the endless glissando and the endless accelerando, in the late 1960s at Bell Labs. Dan Stowell worked out how to schedule it for live performance (ICMC 2011). Christopher Nolan and Hans Zimmer used it in Dunkirk; Ludwig Göransson builds the sack of Troy in The Odyssey on it.',
    ],
  },
  {
    id: 'layers',
    title: 'Layers must lock, not just overlap',
    body: [
      'If you simply play four copies at four tempos, you hear four bands that drift against each other. The illusion needs every copy to be the same groove at a different metrical level: every downbeat of the slow copy must land exactly on a beat of the fast one. Then the ear hears one groove with many levels, and lets its attention slide from one level to the next without noticing a seam.',
      'Here every layer j plays at a rate and phase derived from one shared state: u (how far through the current doubling we are, 0 to 1) and φ (the beat count of the reference layer).',
      '$math R_j = f · r^(u − j)     phase_j = φ · r^(−j)',
      'f is the tempo you perceive, r the ratio between layers (2 for octaves). Because every phase is the same φ scaled by a power of r, neighbouring layers stay locked at exactly r:1 at every instant, whatever happens to the speed. When u reaches 1, layer j is exactly where layer j−1 was, so the engine relabels them (u − 1, φ / r) and nothing audible changes. That relabelling is the whole illusion.',
      'Because the state is integrated step by step rather than written as a fixed function of time, the slope can change at any moment, be zero, or turn negative. That is what lets you steer it by tilting the phone. Onset times inside each step come from the exact inverse of the tempo integral, so they do not depend on the frame rate.',
      'A constant slope a (tempo growing as e^(at)) repeats exactly after one ratio step if φ = R / a: phase equals rate divided by its log-slope. That self-similar state is what the loop exports start from, so the exported WAV and MIDI loop seamlessly in any player.',
    ],
  },
  {
    id: 'window',
    title: 'The window lives on absolute tempo',
    body: [
      'A Shepard tone’s bell is a function of absolute frequency, never of which sine is which. The rhythm works the same way: a layer’s volume depends only on its current tempo. The bell peaks at the focus tempo and is three standard deviations wide each side, about a Gaussian. The layer volumes are normalised so that a hit shared by every layer always has the same loudness, at any point in the cycle.',
      'Where to put the peak follows from how people hear pulse. Tapping along is easiest around 100–120 beats per minute (about 2 Hz) and gets harder in both directions. Faster than roughly 10–12 events per second, separate hits blur into a flutter; slower than one event every two or three seconds, they stop forming a pulse at all. The usable range is about six octaves, and the window sits in the middle of it.',
    ],
  },
  {
    id: 'subdivisions',
    title: 'Dropped subdivisions fall out by themselves',
    body: [
      'Each note belongs to a metrical stream: the bar, the beat, the eighth, the sixteenth. A stream has its own absolute rate: a sixteenth stream at 120 BPM runs at 8 notes per second, the quarter stream at 2. As a layer accelerates, its sixteenths reach the flutter limit two octaves before its quarter notes do.',
      'So instead of a hand-drawn fade, every note fades out when its own stream crosses the flutter limit. The fastest notes of the fastest layer thin out first, exactly the trick Jake Lizzio (Signals Music Studio) calls dropped subdivisions in his analysis of "Troy": as a layer doubles in speed every second note fades away, until the layer is back where it started. Here it is not an extra effect but the same window applied to every stream.',
      'For a melody, a note that sits off the beat but has room around it keeps its own slower rate, so a displaced line (Icct Hedral’s line is shifted by an eighth) survives as a line instead of being treated as decoration.',
    ],
  },
  {
    id: 'hemiola',
    title: 'Ratios other than two',
    body: [
      'Nothing requires the layers to be octaves apart. With a ratio of 3:2 every layer is a hemiola of its neighbour: the bar that one layer feels in two, the next feels in three. The cycle is shorter (0.58 of an octave) and there are more layers in the window, so the ear has even less to hold on to. A ratio of 3 nests triplets inside each other.',
      'Measured in a recording of "Troy", the periodicities form two families of octaves in a 3:2 ratio, consistent with 6/8 felt alternately in two and in three. Signals’ analysis names the hemiola as the third trick. The Troy preset uses a 6/8 groove whose parts sit on the two-feel and the three-feel.',
    ],
  },
  {
    id: 'pitch',
    title: 'The pitch staircase, and making them disagree',
    body: [
      'Every pitched sound here is built to be octave-ambiguous: the drone is a stack of octaves under a fixed bell over frequency, and every melody note is played in neighbouring octaves weighted by the same bell. So pitch can also rise forever, and a melody can drift upward without ever jumping.',
      'Pitch can follow the tempo (as on a tape that is speeding up), move on its own, or move in steps: two-semitone steps give the original stepped Shepard scale, half-semitone steps give a quarter-tone staircase. The strongest disorientation comes from making the two staircases disagree, a paradox Risset liked: a rhythm that accelerates forever while its pitch falls forever.',
      'In "Troy" the riser is different: a held drone near C (about 530 Hz) with voices sliding slowly up against it, at roughly 70–135 seconds per octave, much slower than the tempo doubles (about 29.5 s). The Troy preset keeps a fixed drone under the moving one for that tension.',
    ],
  },
  {
    id: 'tape',
    title: 'Where rhythm turns into pitch',
    body: [
      'Speed a rhythm up past about 20 repetitions per second and you stop hearing hits: you hear a tone whose pitch is the repetition rate and whose colour is the rhythm itself. Karlheinz Stockhausen made this the subject of "...wie die Zeit vergeht..." (1957) and demonstrated it in Kontakte.',
      'The tape layers play one loop of the groove with read heads one ratio step apart, from far below the beat up into the audio range, all under one window and locked to the same state as the drums. The slow heads are a Risset rhythm. The fast heads, each replaying the whole loop hundreds of times a second, are an octave-stacked tone: a Shepard tone made from nothing but the rhythm. One object, heard as both.',
      'Load any recording onto the tape, a voice works best, and the same happens to it: words slow into syllables at the bottom, smear into chatter in the middle, and become a chord at the top, all at once, forever accelerating.',
    ],
  },
  {
    id: 'troy',
    title: 'What the recording of "Troy" shows',
    body: [
      'A tempogram (how strongly each tempo is present over time, on a logarithmic tempo axis) of the cue shows parallel straight lines: tempo grows exponentially, as it must for every layer to double in the same time. The lines double about every 29–30 seconds. The strongest ones at the start of a cycle sit near 81 dotted-quarter beats, 243 eighths and 486 sixteenths per minute.',
      'Signals Music Studio names four tricks: modified Risset rhythms, dropped subdivisions, hemiola and a pitch riser over a drone. Nolan has described the device in interviews as a Risset rhythm, the rhythmic equivalent of the Shepard tone. Göransson has not published how he made it; the tempo, metre and timing in the preset come from measuring the recording.',
    ],
  },
  {
    id: 'pieces',
    title: 'The pieces',
    body: [
      'Icct Hedral, Alberto Balsalm and Acrid Avid Jam Shred are built from MIDI transcriptions of Aphex Twin’s riffs (from ...I Care Because You Do, 1995). Icct Hedral’s repeated notes are pushed an eighth off the beat partway through, a displacement that the staircase turns into a constant metrical shimmer.',
      'Di Meola borrows from Al Di Meola’s fusion guitar: sixteenth notes grouped 3+3+2 and 3+3+3+3+2+2 across the bar, a picked ostinato in a different length from the drums so the downbeat keeps moving, and a Phrygian-dominant line with quarter-tone inflections on a plucked steel string, over a 3:2 layer ladder.',
      'Fosse sets a poem as rhythm. Every word becomes a group of as many sixteenths as it has syllables: 71 syllables, a prime number, so the words never line up with the bar the same way twice. The text that goes with it repeats and turns like Jon Fosse’s prose and ends where it begins, a staircase made of sentences.',
    ],
  },
  {
    id: 'steer',
    title: 'Steering it',
    body: [
      'The speed control sets how many octaves per minute the tempo climbs (or falls). It is a slope, not a tempo: the tempo you hear stays near the focus, while the feeling of acceleration grows with the slope. Tilt the phone forward to accelerate, back to decelerate, sideways to bend the pitch staircase; shake it to give the barber pole a spin. Solo one layer to hear what is really happening: a single copy of the groove accelerating from a crawl to a blur, then disappearing.',
    ],
  },
];
