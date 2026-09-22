import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Button,
  CrmContext,
  ExtensionPointApiActions,
  Text,
} from '@hubspot/ui-extensions';
import { hubspot } from '@hubspot/ui-extensions';

/**
 * Carte technique de synchronisation, affichée dans la barre latérale du ticket.
 *
 * Problème : HubSpot ne rafraîchit jamais une fiche ticket déjà ouverte quand
 * une source externe (workflow, API) en modifie le statut ou le pipeline.
 * L'agent SAV continue de voir l'ancien état jusqu'à un rechargement manuel.
 *
 * Détection : polling actif.
 * La première implémentation s'appuyait sur onCrmPropertiesUpdate, mais ce
 * mécanisme n'est déclenché que par les modifications faites depuis l'interface
 * HubSpot elle-même — comportement documenté, pas un bug. Les écritures API
 * externes (nos workflows SAV) ne produisent aucun événement, l'abonnement
 * restait donc muet. On interroge donc nous-mêmes la propriété tampon
 * (dahu_refresh_signal) à intervalle régulier.
 *
 * Correction : double approche, appel automatique + bouton manuel.
 * refreshObjectProperties() est appelée à chaque changement détecté, mais son
 * périmètre réel ne couvre pas tout ce que l'équipe regarde (voir la section 5
 * du RESUME_TECHNIQUE). On expose donc en plus un bouton de rechargement, qui
 * n'apparaît qu'en cas de changement détecté. Le rechargement n'est jamais
 * déclenché tout seul : il ferait perdre une saisie en cours dans un autre
 * panneau de la fiche.
 */

// Nom interne de la propriété tampon surveillée (créée manuellement côté HubSpot).
const SIGNAL_PROPERTY = 'dahu_refresh_signal';

// Période d'interrogation. Valeur définitive : 1 à 3 agents SAV simultanés au
// maximum, la charge API reste négligeable. À 2 s, le bouton apparaît assez vite
// pour que l'agent le voie en fermant la fenêtre d'action de dahu-sav.
const POLL_INTERVAL_MS = 2000;

/*
 * Journalisation silencieuse par défaut. On conserve les points de log plutôt
 * que de les supprimer : en cas de régression, passer DEBUG à true et
 * redéployer suffit pour retracer le cycle de vie, sans réécrire de code.
 *
 * Attention : un build déployé avec DEBUG à false ne produit AUCUNE ligne. Une
 * console vide ne prouve donc pas que la carte est absente ou inerte — cette
 * confusion a déjà coûté un cycle de diagnostic complet.
 */
const DEBUG = false;

const debugLog = (...args: unknown[]) => {
  if (DEBUG) {
    console.log('[dahu-sync]', ...args);
  }
};

interface CrmExtensionProps {
  context: CrmContext;
  actions: ExtensionPointApiActions<'crm.record.sidebar'>;
}

/*
 * reloadPage n'est pas présente dans le typage des actions de
 * crm.record.sidebar pour cette version du SDK, alors qu'elle est documentée.
 * On y accède donc par une vue élargie, et on vérifie sa présence à
 * l'exécution avant de l'appeler (voir handleReload).
 */
type ActionsWithReload = ExtensionPointApiActions<'crm.record.sidebar'> & {
  reloadPage?: () => unknown;
};

hubspot.extend<'crm.record.sidebar'>(
  ({ context, actions }: CrmExtensionProps) => (
    <CrmExtension context={context} actions={actions} />
  )
);

const CrmExtension = ({ actions }: CrmExtensionProps) => {
  const { fetchCrmObjectProperties, refreshObjectProperties, addAlert } =
    actions;

  /*
   * Dernière valeur connue stockée dans une ref et non dans un state : elle
   * sert uniquement à la comparaison entre deux ticks, jamais au rendu. Un
   * state provoquerait des re-rendus inutiles et une closure obsolète dans le
   * callback d'intervalle.
   */
  const lastSignal = useRef<string | null>(null);

  // Tant que la lecture initiale n'a pas abouti, on ne signale aucun changement
  // (sinon le premier tick afficherait le bouton pour rien au montage).
  const initialized = useRef(false);

  /*
   * Seul état de rendu : un changement a été détecté depuis l'affichage de la
   * fiche, donc ce que voit l'agent est potentiellement périmé.
   *
   * Il ne bascule que sur changement réel du signal : la carte ne se re-rend
   * pas à chaque tick. Les dépendances du useEffect étant toutes stables, un
   * re-rendu ne réexécute jamais l'effet et ne recrée jamais l'intervalle.
   */
  const [updateAvailable, setUpdateAvailable] = useState(false);

  // Normalisation : selon le type (datetime ou number) la valeur peut arriver
  // en chaîne ou en nombre. On compare toujours des chaînes.
  const normalize = useCallback(
    (value: unknown): string | null =>
      value === undefined || value === null ? null : String(value),
    []
  );

  /*
   * Rechargement complet de la fiche, sur clic de l'agent uniquement.
   *
   * Repli défensif : si l'action n'existe pas dans le SDK déployé, on ne plante
   * pas — on affiche une alerte demandant un rechargement manuel, ce qui laisse
   * l'agent dans un état correct plutôt que devant une carte muette.
   */
  const handleReload = useCallback(() => {
    const reloadPage = (actions as ActionsWithReload).reloadPage;

    if (typeof reloadPage === 'function') {
      debugLog('Rechargement de la page demandé par l’agent');
      reloadPage();
      return;
    }

    console.error(
      '[dahu-sync] Action reloadPage indisponible dans ce SDK — repli sur une alerte'
    );
    addAlert({
      type: 'warning',
      message:
        'Cette fiche a été modifiée. Rechargez la page pour voir les données à jour.',
    });
  }, [actions, addAlert]);

  useEffect(() => {
    // Vrai tant que le composant est monté : empêche toute écriture de ref ou
    // de state déclenchée par une requête encore en vol après démontage.
    let active = true;

    /* Lecture de la propriété tampon, partagée entre le montage et chaque tick. */
    const readSignal = () =>
      fetchCrmObjectProperties([SIGNAL_PROPERTY])
        .then((properties: Record<string, unknown> | undefined) => {
          if (!active) return;

          const nextSignal = normalize(properties?.[SIGNAL_PROPERTY]);

          // 1. Premier passage : on mémorise la valeur de référence, sans rien
          //    signaler — la fiche vient d'être chargée, elle est à jour.
          if (!initialized.current) {
            lastSignal.current = nextSignal;
            initialized.current = true;
            debugLog('Lecture initiale réussie, valeur =', nextSignal);
            return;
          }

          // 2. Ticks suivants : on ne réagit que sur changement réel.
          if (nextSignal === lastSignal.current) {
            return;
          }

          lastSignal.current = nextSignal;
          debugLog('Changement détecté, nouvelle valeur =', nextSignal);

          /*
           * Appel automatique conservé : il ne coûte rien et rafraîchit ce qui
           * relève effectivement de son périmètre. Il ne suffit pas seul — d'où
           * le bouton ci-dessous — mais le retirer dégraderait les cas qui
           * fonctionnent déjà.
           */
          try {
            refreshObjectProperties();
          } catch (error: unknown) {
            console.error(
              '[dahu-sync] refreshObjectProperties() a levé une exception',
              error
            );
          }

          // Filet de sécurité : on rend la main à l'agent.
          setUpdateAvailable(true);
        })
        .catch((error: unknown) => {
          // Un échec ponctuel (réseau, throttling API) ne doit pas tuer le
          // polling : on log et on laisse le tick suivant retenter. Cette erreur
          // reste visible même hors DEBUG, elle signale une anomalie réelle.
          console.error(
            '[dahu-sync] Lecture de la propriété tampon impossible sur ce tick',
            error
          );
        });

    debugLog(
      'Démarrage du polling sur',
      SIGNAL_PROPERTY,
      `toutes les ${POLL_INTERVAL_MS} ms`
    );

    // Lecture initiale immédiate, puis répétition à intervalle fixe.
    readSignal();
    const intervalId = setInterval(readSignal, POLL_INTERVAL_MS);

    // 3. Nettoyage au démontage : sans clearInterval, l'intervalle survivrait à
    // la carte et continuerait d'appeler l'API dans le vide.
    return () => {
      active = false;
      clearInterval(intervalId);
      debugLog('Arrêt du polling');
    };
  }, [fetchCrmObjectProperties, refreshObjectProperties, normalize]);

  /*
   * Rendu : un seul élément dans chaque branche, volontairement. Le SDK exige
   * un retour JSX non nul, et s'en tenir à un élément simple évite tout risque
   * de rendu sur un composant de mise en page.
   */
  if (updateAvailable) {
    return (
      <Button variant="primary" onClick={handleReload}>
        Mise à jour disponible — actualiser
      </Button>
    );
  }

  return <Text>Synchronisation active</Text>;
};
