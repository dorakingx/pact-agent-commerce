/**
 * The scripted copywriter's material: for each language, eight angles on a subject (an opening
 * line that names the subject plus supporting sentences), general supporting sentences, closing
 * lines per register, short lines used to land exactly inside a word range, and a sentence frame
 * for long-form requests.
 *
 * Every sentence is complete and grammatical on its own, and the subject is only ever inserted
 * as a quoted or prepositional phrase, so the copy reads correctly whatever the subject is.
 */
import { languageName as knownLanguageName } from "../domain/format";
import { LANGUAGES, type Language } from "../domain/schemas";

export type Register = "neutral" | "friendly" | "formal";

export interface Angle {
  /** Headline of the angle; also used as the short lead line of very short pieces. */
  title: string;
  /** Opening sentence; "{subject}" is replaced with the (quoted) subject. */
  opener: string;
  body: readonly string[];
}

export interface CopyPack {
  /** How the subject is embedded in a sentence (languages other than English quote it as a name). */
  quote: (subject: string) => string;
  /** Sentence terminator used when a title becomes a lead line. */
  stop: string;
  /** Separator between sentences inside a paragraph. */
  joiner: string;
  angles: readonly Angle[];
  shared: readonly string[];
  closers: Readonly<Record<Register, string>>;
  /** Short complete lines of different lengths; at least one must count as a single word. */
  pads: readonly string[];
  /** Long-form sentence built from one aspect, one quality and one benefit. */
  frame: (aspect: string, quality: string, benefit: string) => string;
  aspects: readonly string[];
  qualities: readonly string[];
  benefits: readonly string[];
}

const en: CopyPack = {
  quote: (subject) => subject,
  stop: ".",
  joiner: " ",
  angles: [
    {
      title: "Built with care",
      opener: "When it comes to {subject}, the details decide everything.",
      body: [
        "Every element is considered, tested and refined until it feels exactly right.",
        "Nothing is added without a reason, and nothing essential is left out.",
        "The result is quality you notice on the first day.",
        "It is also quality you still appreciate years later.",
      ],
    },
    {
      title: "Simple from the start",
      opener: "The best thing about {subject} is how little effort it asks of you.",
      body: [
        "Getting started takes minutes, and the essentials are exactly where you expect them.",
        "There are no confusing options and no steep learning curve.",
        "Anyone can feel at home from the very first day.",
        "You get straight to the result you came for.",
      ],
    },
    {
      title: "Made to be relied on",
      opener: "With {subject}, reliability comes first.",
      body: [
        "Each part is checked under real conditions before it ever reaches you.",
        "Performance stays the same on the busiest day and on the quietest one.",
        "That consistency brings peace of mind every single day.",
        "It is the reason our customers keep coming back.",
      ],
    },
    {
      title: "Designed around people",
      opener: "Good design is at the heart of {subject}.",
      body: [
        "Clean lines and thoughtful proportions make it a pleasure to look at.",
        "More importantly, every shape and surface serves the person using it.",
        "It fits naturally into any space.",
        "It also settles into a daily routine without any effort.",
      ],
    },
    {
      title: "Value that lasts",
      opener: "Think of {subject} as an investment that keeps paying back.",
      body: [
        "Durable materials and efficient engineering keep running costs low.",
        "You spend less time on upkeep and more time enjoying the benefits.",
        "Over the years, the difference only grows.",
        "The satisfaction goes well beyond the price.",
      ],
    },
    {
      title: "Help when you need it",
      opener: "Choosing {subject} also means choosing the people behind it.",
      body: [
        "Our team answers questions quickly and in plain language.",
        "Clear guides and friendly experts are available whenever you need them.",
        "Nobody is left to solve a problem alone.",
        "That support continues long after the purchase.",
      ],
    },
    {
      title: "Responsible by design",
      opener: "We believe {subject} should be good for people and gentle on the planet.",
      body: [
        "Materials are chosen for a long life and a small footprint.",
        "Packaging is minimal and recyclable wherever possible.",
        "Small decisions like these make a real difference at scale.",
        "We keep improving today with tomorrow in mind.",
      ],
    },
    {
      title: "Performance you can feel",
      opener: "Performance is where {subject} truly stands apart.",
      body: [
        "Power arrives smoothly, precisely and without delay.",
        "Demanding tasks are handled as easily as everyday ones.",
        "You notice the difference from the very first use.",
        "Your confidence grows every time you come back to it.",
      ],
    },
  ],
  shared: [
    "Above all, we care about comfort in everyday use.",
    "We listen to the people who use it and improve with every piece of feedback.",
    "At every stage, specialists take responsibility for the quality of their work.",
    "Quality is checked several times before anything is released.",
    "It is a good choice for beginners and for experts alike.",
    "The information you need is available at the moment you need it.",
    "We make no compromises, even on the smallest details.",
    "It follows the rhythm of your life and your work.",
    "We want every customer to feel they chose well.",
    "What you use every day deserves to be chosen with confidence.",
  ],
  closers: {
    neutral: "See it for yourself today.",
    friendly: "Come and give it a try.",
    formal: "Contact our team for further details.",
  },
  pads: [
    "Simple.",
    "Try it.",
    "See the difference.",
    "Made for real life.",
    "It simply works every day.",
    "Quality you can see and feel.",
    "Everything you need and nothing you do not.",
  ],
  frame: (aspect, quality, benefit) => `When it comes to ${aspect}, the result is ${quality}: ${benefit}.`,
  aspects: [
    "materials",
    "everyday use",
    "setup",
    "upkeep",
    "safety",
    "comfort",
    "durability",
    "packaging",
    "delivery",
    "customer care",
  ],
  qualities: [
    "clear and dependable",
    "simple and predictable",
    "carefully thought through",
    "better than expected",
    "consistent from day to day",
    "easy to appreciate",
  ],
  benefits: [
    "you save time",
    "there are fewer surprises",
    "small problems never grow into big ones",
    "the experience stays enjoyable",
    "you can focus on what matters",
    "confidence comes naturally",
  ],
};

const ja: CopyPack = {
  quote: (subject) => `「${subject}」`,
  stop: "。",
  joiner: "",
  angles: [
    {
      title: "細部までていねいに",
      opener: "{subject}で大切にしているのは、細部へのこだわりです。",
      body: [
        "ひとつひとつの要素を見直し、納得できるまで磨き上げました。",
        "必要なものだけを残し、余計なものは加えていません。",
        "手にした瞬間から、その違いを感じていただけます。",
        "長く使うほど、良さが実感できる仕上がりです。",
      ],
    },
    {
      title: "はじめから、かんたん",
      opener: "{subject}は、使う人に手間をかけさせません。",
      body: [
        "準備は数分で終わり、必要な機能はすぐに見つかります。",
        "迷いやすい設定や、むずかしい手順はありません。",
        "初めての方でも、その日から使いこなせます。",
        "やりたいことに、まっすぐたどり着けます。",
      ],
    },
    {
      title: "毎日、頼れる",
      opener: "{subject}では、信頼性を何よりも優先しています。",
      body: [
        "すべての部品を、実際の使用環境で確認しています。",
        "忙しい日も静かな日も、同じ品質を保ちます。",
        "安定した性能が、毎日の安心につながります。",
        "その積み重ねが、長く選ばれている理由です。",
      ],
    },
    {
      title: "人を中心にしたデザイン",
      opener: "{subject}の中心にあるのは、使う人のためのデザインです。",
      body: [
        "すっきりとした形と、心地よいバランスに仕上げました。",
        "見た目の美しさだけでなく、使いやすさも考え抜いています。",
        "どんな空間にも、自然になじみます。",
        "毎日の習慣に、無理なく寄り添います。",
      ],
    },
    {
      title: "長く続く価値",
      opener: "{subject}は、長く価値を生み続ける選択です。",
      body: [
        "丈夫な素材と効率のよい設計で、維持にかかる費用を抑えます。",
        "手入れにかかる時間が減り、楽しむ時間が増えます。",
        "年月を重ねるほど、その差は大きくなります。",
        "価格以上の満足を、お届けします。",
      ],
    },
    {
      title: "いつでも、そばに",
      opener: "{subject}を選ぶことは、それを支える人たちを選ぶことでもあります。",
      body: [
        "ご質問には、わかりやすい言葉ですばやくお答えします。",
        "ていねいなガイドと専門スタッフが、いつでもお手伝いします。",
        "困ったときに、ひとりで悩む必要はありません。",
        "ご購入のあとも、ずっとサポートが続きます。",
      ],
    },
    {
      title: "環境にも、やさしく",
      opener: "{subject}は、人にも地球にもやさしくあるべきだと考えています。",
      body: [
        "素材は、長く使えて環境への負担が少ないものを選びました。",
        "包装は最小限にし、できるかぎりリサイクルできるようにしています。",
        "小さな工夫の積み重ねが、大きな違いを生みます。",
        "未来のために、いまできることを続けています。",
      ],
    },
    {
      title: "体感できる性能",
      opener: "{subject}の実力は、性能にこそあらわれます。",
      body: [
        "力強さを、なめらかに、正確に、遅れなく届けます。",
        "負荷の高い作業も、ふだんの作業と同じように軽くこなします。",
        "最初の一回から、違いがはっきりわかります。",
        "使うたびに、頼もしさを感じられます。",
      ],
    },
  ],
  shared: [
    "私たちは、毎日の使いやすさを何よりも大切にしています。",
    "実際に使う人の声を聞き、改良を重ねてきました。",
    "どの工程にも、専門のスタッフが責任を持って関わっています。",
    "品質は、お届けする前に何度も確認しています。",
    "はじめての方にも、経験のある方にもおすすめできます。",
    "必要なときに、必要な情報がすぐに手に入ります。",
    "細かな部分まで、妥協はありません。",
    "暮らしや仕事のリズムに、しっかり合わせられます。",
    "選んでよかったと思える体験を、目指しています。",
    "毎日使うものだからこそ、安心して選んでいただけます。",
  ],
  closers: {
    neutral: "ぜひ一度、お試しください。",
    friendly: "まずは気軽に、試してみてください。",
    formal: "詳しくは、担当までお問い合わせください。",
  },
  pads: ["ぜひ。", "ぜひどうぞ。", "毎日に安心。", "品質が違います。", "毎日に、安心をお届け。", "使うほどに、良さがわかります。"],
  frame: (aspect, quality, benefit) => `${aspect}の面では、${quality}仕上がりで、${benefit}。`,
  aspects: ["素材", "日々の使い勝手", "準備", "お手入れ", "安全性", "快適さ", "耐久性", "包装", "お届け", "サポート"],
  qualities: [
    "安定して信頼できる",
    "わかりやすく無理のない",
    "細部まで考え抜かれた",
    "期待を上回る",
    "毎日変わらない",
    "良さが伝わりやすい",
  ],
  benefits: [
    "時間を節約できます",
    "思わぬトラブルが減ります",
    "小さな問題が大きくなりません",
    "心地よさが長く続きます",
    "大切なことに集中できます",
    "自然と安心感が生まれます",
  ],
};

const es: CopyPack = {
  quote: (subject) => `«${subject}»`,
  stop: ".",
  joiner: " ",
  angles: [
    {
      title: "Hecho con cuidado",
      opener: "Cuando se trata de {subject}, los detalles lo deciden todo.",
      body: [
        "Cada elemento se estudia, se prueba y se perfecciona hasta que funciona de verdad.",
        "No añadimos nada sin motivo y no dejamos fuera nada esencial.",
        "El resultado es una calidad que se nota desde el primer día.",
        "Es una calidad que se sigue apreciando con el paso de los años.",
      ],
    },
    {
      title: "Sencillo desde el principio",
      opener: "Lo mejor de {subject} es el poco esfuerzo que exige.",
      body: [
        "La puesta en marcha lleva unos minutos y lo esencial está donde uno espera.",
        "No hay opciones confusas ni una curva de aprendizaje difícil.",
        "Cualquier persona puede aprovecharlo desde el primer día.",
        "Así se llega directamente al resultado deseado.",
      ],
    },
    {
      title: "Hecho para confiar",
      opener: "Con {subject}, la fiabilidad es lo primero.",
      body: [
        "Cada pieza se comprueba en condiciones reales antes de llegar a sus manos.",
        "El rendimiento se mantiene igual en el día más ajetreado y en el más tranquilo.",
        "Esa constancia aporta tranquilidad todos los días.",
        "Por eso nuestros clientes vuelven a elegirnos.",
      ],
    },
    {
      title: "Diseñado para las personas",
      opener: "El buen diseño es el corazón de {subject}.",
      body: [
        "Las líneas limpias y las proporciones cuidadas hacen que sea un placer mirarlo.",
        "Además, cada forma y cada superficie están pensadas para quien lo utiliza.",
        "Encaja de forma natural en cualquier espacio.",
        "También se adapta sin esfuerzo a la rutina diaria.",
      ],
    },
    {
      title: "Un valor que perdura",
      opener: "Piense en {subject} como una inversión que se recupera con creces.",
      body: [
        "Los materiales duraderos y una ingeniería eficiente mantienen bajos los costes.",
        "Se dedica menos tiempo al mantenimiento y más a disfrutar de las ventajas.",
        "Con los años, la diferencia se hace cada vez mayor.",
        "Es una satisfacción que supera con mucho al precio.",
      ],
    },
    {
      title: "Ayuda cuando hace falta",
      opener: "Elegir {subject} también significa elegir a las personas que hay detrás.",
      body: [
        "Nuestro equipo responde a las preguntas con rapidez y con un lenguaje claro.",
        "Hay guías sencillas y especialistas disponibles siempre que se necesiten.",
        "Nadie tiene que resolver un problema a solas.",
        "El acompañamiento continúa mucho después de la compra.",
      ],
    },
    {
      title: "Responsable por diseño",
      opener: "Creemos que {subject} debe ser bueno para las personas y respetuoso con el planeta.",
      body: [
        "Elegimos materiales de larga vida y de bajo impacto.",
        "El embalaje es mínimo y reciclable siempre que es posible.",
        "Las pequeñas decisiones como estas marcan una gran diferencia.",
        "Seguimos mejorando hoy pensando en el mañana.",
      ],
    },
    {
      title: "Rendimiento que se nota",
      opener: "El rendimiento es donde {subject} marca de verdad la diferencia.",
      body: [
        "La potencia llega con suavidad, con precisión y sin esperas.",
        "Las tareas exigentes se resuelven con la misma facilidad que las cotidianas.",
        "La diferencia se percibe desde el primer uso.",
        "La confianza crece cada vez que se utiliza.",
      ],
    },
  ],
  shared: [
    "Ante todo, cuidamos la comodidad del uso diario.",
    "Escuchamos a quienes lo utilizan y mejoramos con cada opinión.",
    "En cada etapa participan especialistas que responden de su trabajo.",
    "La calidad se comprueba varias veces antes de cada lanzamiento.",
    "Es una buena elección tanto para principiantes como para expertos.",
    "La información necesaria está disponible en el momento oportuno.",
    "No hacemos concesiones ni en los detalles más pequeños.",
    "Se adapta al ritmo de la vida y del trabajo.",
    "Queremos que cada cliente sienta que eligió bien.",
    "Lo que se usa a diario merece elegirse con tranquilidad.",
  ],
  closers: {
    neutral: "Descúbralo hoy mismo.",
    friendly: "Anímese a probarlo.",
    formal: "Póngase en contacto con nuestro equipo para más información.",
  },
  pads: [
    "Pruébelo.",
    "Calidad garantizada.",
    "Así de sencillo.",
    "Pensado para cada día.",
    "Todo lo que hace falta.",
    "Una diferencia que se nota enseguida.",
    "Todo lo necesario y nada que sobre.",
  ],
  frame: (aspect, quality, benefit) => `En cuanto a ${aspect}, el resultado es ${quality}: ${benefit}.`,
  aspects: [
    "los materiales",
    "el uso diario",
    "la instalación",
    "el mantenimiento",
    "la seguridad",
    "la comodidad",
    "la durabilidad",
    "el embalaje",
    "la entrega",
    "la atención al cliente",
  ],
  qualities: [
    "claro y fiable",
    "sencillo y previsible",
    "muy bien pensado",
    "mejor de lo esperado",
    "constante día tras día",
    "fácil de apreciar",
  ],
  benefits: [
    "se ahorra tiempo",
    "hay menos sorpresas",
    "los pequeños problemas no crecen",
    "la experiencia sigue siendo agradable",
    "es posible centrarse en lo importante",
    "la confianza llega de forma natural",
  ],
};

const fr: CopyPack = {
  quote: (subject) => `« ${subject} »`,
  stop: ".",
  joiner: " ",
  angles: [
    {
      title: "Le soin du détail",
      opener: "Quand il s’agit de {subject}, ce sont les détails qui font tout.",
      body: [
        "Chaque élément est étudié, testé et affiné jusqu’à ce qu’il soit juste.",
        "Rien n’est ajouté sans raison et rien d’essentiel n’est oublié.",
        "Le résultat est une qualité que l’on remarque dès le premier jour.",
        "C’est aussi une qualité que l’on apprécie encore après des années.",
      ],
    },
    {
      title: "Simple dès le départ",
      opener: "Le grand atout de {subject}, c’est le peu d’effort demandé.",
      body: [
        "La mise en route prend quelques minutes et l’essentiel se trouve là où on l’attend.",
        "Il n’y a ni option déroutante ni apprentissage difficile.",
        "Chacun peut en profiter dès le premier jour.",
        "On arrive ainsi directement au résultat recherché.",
      ],
    },
    {
      title: "Conçu pour inspirer confiance",
      opener: "Avec {subject}, la fiabilité passe avant tout.",
      body: [
        "Chaque pièce est vérifiée en conditions réelles avant d’arriver chez vous.",
        "Les performances restent les mêmes, les jours chargés comme les jours calmes.",
        "Cette constance apporte une vraie tranquillité au quotidien.",
        "C’est pourquoi nos clients nous restent fidèles.",
      ],
    },
    {
      title: "Pensé pour les personnes",
      opener: "Le design est au cœur de {subject}.",
      body: [
        "Des lignes nettes et des proportions soignées en font un plaisir pour les yeux.",
        "Surtout, chaque forme et chaque surface servent la personne qui l’utilise.",
        "L’ensemble trouve naturellement sa place dans tous les espaces.",
        "Il s’adapte aussi sans effort aux habitudes de chacun.",
      ],
    },
    {
      title: "Une valeur qui dure",
      opener: "Voyez {subject} comme un investissement qui rapporte longtemps.",
      body: [
        "Des matériaux durables et une conception efficace réduisent les coûts d’usage.",
        "On passe moins de temps à l’entretien et davantage à en profiter.",
        "Au fil des années, l’écart ne cesse de grandir.",
        "La satisfaction dépasse largement le prix.",
      ],
    },
    {
      title: "Une aide toujours proche",
      opener: "Choisir {subject}, c’est aussi choisir les personnes qui l’accompagnent.",
      body: [
        "Notre équipe répond vite et avec des mots simples.",
        "Des guides clairs et des spécialistes sont disponibles à tout moment.",
        "Personne ne reste seul face à une difficulté.",
        "L’accompagnement continue bien après l’achat.",
      ],
    },
    {
      title: "Responsable par nature",
      opener: "Nous pensons que {subject} doit être bon pour chacun et doux pour la planète.",
      body: [
        "Les matériaux sont choisis pour leur longue durée de vie et leur faible impact.",
        "L’emballage est réduit et recyclable autant que possible.",
        "Ces petites décisions font une grande différence à grande échelle.",
        "Nous progressons aujourd’hui en pensant à demain.",
      ],
    },
    {
      title: "Des performances qui se sentent",
      opener: "C’est sur les performances que {subject} fait vraiment la différence.",
      body: [
        "La puissance arrive en douceur, avec précision et sans attente.",
        "Les tâches exigeantes sont traitées aussi facilement que les tâches courantes.",
        "La différence se remarque dès la première utilisation.",
        "La confiance grandit à chaque usage.",
      ],
    },
  ],
  shared: [
    "Avant tout, nous soignons le confort d’usage au quotidien.",
    "Nous écoutons les utilisateurs et nous progressons avec chaque retour.",
    "À chaque étape, des spécialistes s’engagent sur la qualité de leur travail.",
    "La qualité est contrôlée plusieurs fois avant chaque lancement.",
    "C’est un bon choix pour les débutants comme pour les experts.",
    "Les informations utiles sont disponibles au bon moment.",
    "Nous ne faisons aucun compromis, même sur les plus petits détails.",
    "L’ensemble suit le rythme de la vie et du travail.",
    "Nous voulons que chaque client soit heureux de son choix.",
    "Ce que l’on utilise chaque jour mérite d’être choisi sereinement.",
  ],
  closers: {
    neutral: "Découvrez-le dès aujourd’hui.",
    friendly: "Laissez-vous tenter.",
    formal: "Contactez notre équipe pour en savoir plus.",
  },
  pads: [
    "Essayez.",
    "Qualité garantie.",
    "Pensé pour vous.",
    "Tout ce qu’il faut.",
    "Pensé pour tous les jours.",
    "Une différence qui se voit très vite.",
    "Tout le nécessaire et rien de trop ici.",
  ],
  frame: (aspect, quality, benefit) => `Côté ${aspect}, le résultat est ${quality} : ${benefit}.`,
  aspects: [
    "matériaux",
    "usage quotidien",
    "installation",
    "entretien",
    "sécurité",
    "confort",
    "durabilité",
    "emballage",
    "livraison",
    "service client",
  ],
  qualities: [
    "clair et fiable",
    "simple et prévisible",
    "mûrement réfléchi",
    "meilleur que prévu",
    "constant jour après jour",
    "facile à apprécier",
  ],
  benefits: [
    "on gagne du temps",
    "il y a moins de surprises",
    "les petits problèmes ne grandissent pas",
    "l’expérience reste agréable",
    "on peut se concentrer sur l’essentiel",
    "la confiance vient naturellement",
  ],
};

const de: CopyPack = {
  quote: (subject) => `„${subject}“`,
  stop: ".",
  joiner: " ",
  angles: [
    {
      title: "Mit Sorgfalt gemacht",
      opener: "Wenn es um {subject} geht, entscheiden die Details.",
      body: [
        "Jedes Element wird durchdacht, geprüft und verfeinert, bis es wirklich stimmt.",
        "Nichts kommt ohne Grund hinzu, und nichts Wesentliches fehlt.",
        "Das Ergebnis ist Qualität, die man vom ersten Tag an bemerkt.",
        "Es ist auch Qualität, die man nach Jahren noch schätzt.",
      ],
    },
    {
      title: "Einfach von Anfang an",
      opener: "Das Beste an {subject} ist, wie wenig Aufwand nötig ist.",
      body: [
        "Die Einrichtung dauert nur Minuten, und das Wichtigste ist dort, wo man es erwartet.",
        "Es gibt keine verwirrenden Optionen und keine lange Einarbeitung.",
        "Jeder kann vom ersten Tag an davon profitieren.",
        "So kommt man direkt zum gewünschten Ergebnis.",
      ],
    },
    {
      title: "Gemacht für Verlässlichkeit",
      opener: "Bei {subject} steht Zuverlässigkeit an erster Stelle.",
      body: [
        "Jedes Teil wird unter realen Bedingungen geprüft, bevor es bei Ihnen ankommt.",
        "Die Leistung bleibt gleich, an hektischen wie an ruhigen Tagen.",
        "Diese Beständigkeit sorgt jeden Tag für ein gutes Gefühl.",
        "Deshalb entscheiden sich unsere Kunden immer wieder für uns.",
      ],
    },
    {
      title: "Für Menschen gestaltet",
      opener: "Gutes Design ist das Herzstück von {subject}.",
      body: [
        "Klare Linien und ausgewogene Proportionen machen den Anblick zur Freude.",
        "Vor allem dient jede Form und jede Fläche dem Menschen, der sie nutzt.",
        "Das Ganze fügt sich ganz natürlich in jeden Raum ein.",
        "Es passt sich auch mühelos dem Alltag an.",
      ],
    },
    {
      title: "Wert, der bleibt",
      opener: "Betrachten Sie {subject} als Investition, die sich lange auszahlt.",
      body: [
        "Langlebige Materialien und effiziente Technik halten die laufenden Kosten niedrig.",
        "Man verbringt weniger Zeit mit der Pflege und mehr Zeit mit den Vorteilen.",
        "Über die Jahre wird der Unterschied immer größer.",
        "Die Zufriedenheit übertrifft den Preis deutlich.",
      ],
    },
    {
      title: "Hilfe, wenn sie gebraucht wird",
      opener: "Wer sich für {subject} entscheidet, entscheidet sich auch für die Menschen dahinter.",
      body: [
        "Unser Team beantwortet Fragen schnell und in klarer Sprache.",
        "Verständliche Anleitungen und Fachleute stehen jederzeit bereit.",
        "Niemand muss ein Problem allein lösen.",
        "Die Begleitung geht weit über den Kauf hinaus.",
      ],
    },
    {
      title: "Verantwortung von Anfang an",
      opener: "Wir finden, {subject} sollte gut für Menschen und schonend für die Umwelt sein.",
      body: [
        "Die Materialien werden nach langer Lebensdauer und geringer Belastung ausgewählt.",
        "Die Verpackung ist sparsam und, wo immer möglich, recycelbar.",
        "Kleine Entscheidungen wie diese machen im Großen einen echten Unterschied.",
        "Wir verbessern uns heute mit Blick auf morgen.",
      ],
    },
    {
      title: "Leistung, die man spürt",
      opener: "Bei der Leistung zeigt {subject}, was wirklich möglich ist.",
      body: [
        "Die Kraft kommt gleichmäßig, präzise und ohne Verzögerung an.",
        "Anspruchsvolle Aufgaben gelingen so leicht wie alltägliche.",
        "Den Unterschied bemerkt man schon bei der ersten Nutzung.",
        "Das Vertrauen wächst mit jedem Einsatz.",
      ],
    },
  ],
  shared: [
    "Vor allem achten wir auf Komfort im täglichen Gebrauch.",
    "Wir hören den Nutzern zu und werden mit jeder Rückmeldung besser.",
    "In jeder Phase stehen Fachleute für die Qualität ihrer Arbeit ein.",
    "Die Qualität wird vor jedem Start mehrfach geprüft.",
    "Es ist eine gute Wahl für Einsteiger und für Profis.",
    "Wichtige Informationen sind genau dann verfügbar, wenn man sie braucht.",
    "Auch bei den kleinsten Details gehen wir keine Kompromisse ein.",
    "Das Ganze folgt dem Rhythmus von Leben und Arbeit.",
    "Wir möchten, dass alle Kunden ihre Wahl gern getroffen haben.",
    "Was man täglich nutzt, sollte man mit gutem Gefühl auswählen.",
  ],
  closers: {
    neutral: "Entdecken Sie es noch heute.",
    friendly: "Probieren Sie es einfach aus.",
    formal: "Kontaktieren Sie unser Team für weitere Informationen.",
  },
  pads: [
    "Überzeugend.",
    "Ganz einfach.",
    "Qualität, die bleibt.",
    "Gemacht für jeden Tag.",
    "Alles, was man wirklich braucht.",
    "Ein Unterschied, den man sofort bemerkt.",
    "Alles Nötige und nichts, was nur stört.",
  ],
  // A dash rather than a colon: after a colon German capitalises a full clause, after a dash it does not.
  frame: (aspect, quality, benefit) => `Bei ${aspect} ist das Ergebnis ${quality} – ${benefit}.`,
  aspects: [
    "den Materialien",
    "der täglichen Nutzung",
    "der Einrichtung",
    "der Pflege",
    "der Sicherheit",
    "dem Komfort",
    "der Haltbarkeit",
    "der Verpackung",
    "der Lieferung",
    "dem Kundenservice",
  ],
  qualities: [
    "klar und verlässlich",
    "einfach und vorhersehbar",
    "sorgfältig durchdacht",
    "besser als erwartet",
    "Tag für Tag gleichbleibend",
    "leicht zu schätzen",
  ],
  benefits: [
    "man spart Zeit",
    "es gibt weniger Überraschungen",
    "kleine Probleme werden nicht groß",
    "das Erlebnis bleibt angenehm",
    "man kann sich auf das Wesentliche konzentrieren",
    "Vertrauen entsteht ganz von selbst",
  ],
};

export const COPY_PACKS: Readonly<Record<Language, CopyPack>> = { en, ja, es, fr, de };

/** Display name of a language code; a code PACT does not know (seller labels are free text) is shown as is. */
export function languageName(code: string): string {
  const known = LANGUAGES.find((language) => language === code);
  return known === undefined ? code : knownLanguageName(known);
}
