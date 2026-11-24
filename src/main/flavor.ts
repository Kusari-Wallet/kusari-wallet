// Which kind of build this is. The developer build (scripts/dist-dev.js) is for trying coins and features before they
// reach everyone: it has its own name and data folder, so it never touches the regular wallet's data.
declare const __KUSARI_FLAVOR__: string | undefined;

export const DEVELOPER_BUILD: boolean = (typeof __KUSARI_FLAVOR__ !== 'undefined' ? __KUSARI_FLAVOR__ : process.env.KUSARI_FLAVOR) === 'developer';
