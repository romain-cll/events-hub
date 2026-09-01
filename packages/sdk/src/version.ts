/**
 * La version du SDK, remplacée au build par celle de `package.json`.
 *
 * ## Pourquoi une constante remplacée, et pas un import de `package.json`
 *
 * Le SDK est livré en deux formes — un module ESM et un bundle IIFE servi par
 * l'API — et aucune des deux ne peut lire un fichier à l'exécution. Un import du
 * manifeste ferait entrer tout son contenu dans le bundle pour n'en garder qu'un
 * champ. esbuild remplace donc le jeton à la compilation (`--define`), et il n'en
 * reste qu'une chaîne littérale.
 *
 * ## Ce qu'elle sert, et ce qu'elle ne sert pas
 *
 * Elle **n'est pas** une version d'événement : la forme d'un événement n'est pas
 * versionnée, et la compatibilité du fil est portée par le préfixe `/v1` de
 * l'API. Elle sert à répondre à une seule question, en débogage — *quelle
 * version du SDK a émis ça* — le jour où une version émet du mauvais.
 *
 * Elle voyage donc dans `attributes`, avec le reste du contexte fourni par le
 * client, et pas en colonne : rien ne se joint dessus.
 *
 * Le repli `0.0.0` est ce que vaut le paquet tant qu'il n'est pas publié. Il
 * décrira quelque chose le jour où il sera versionné pour de bon.
 */
declare const __SDK_VERSION__: string | undefined;

export const SDK_VERSION: string =
  typeof __SDK_VERSION__ === 'string' ? __SDK_VERSION__ : '0.0.0';
