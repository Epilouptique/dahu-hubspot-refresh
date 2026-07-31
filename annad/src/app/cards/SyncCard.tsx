import { useCallback, useEffect, useRef } from 'react';
import {
  CrmContext,
  ExtensionPointApiActions,
  Text,
} from '@hubspot/ui-extensions';
import { hubspot } from '@hubspot/ui-extensions';

/**
 * Carte technique de synchronisation (invisible fonctionnellement).
 *
 * Problème : HubSpot ne rafraîchit jamais une fiche ticket déjà ouverte quand
 * une source externe (workflow, API) en modifie le statut ou le pipeline.
 * L'agent SAV continue de voir l'ancien état jusqu'à un rechargement manuel.
 *
 * Stratégie retenue : polling actif.
 * La première implémentation s'appuyait sur onCrmPropertiesUpdate, mais ce
 * mécanisme n'est déclenché que par les modifications faites depuis l'interface
 * HubSpot elle-même — comportement documenté, pas un bug. Les écritures API
 * externes (nos workflows SAV) ne produisent aucun événement, l'abonnement
 * restait donc muet. On interroge désormais nous-mêmes la propriété tampon
 * (dahu_refresh_signal) à intervalle régulier et on déclenche
 * refreshObjectProperties() dès que sa valeur change.
 */

// Nom interne de la propriété tampon surveillée (créée manuellement côté HubSpot).
const SIGNAL_PROPERTY = 'dahu_refresh_signal';

// Période d'interrogation. Valeur définitive : 1 à 3 agents SAV simultanés au
// maximum, la charge API reste négligeable et la latence perçue est nulle.
const POLL_INTERVAL_MS = 5000;

/*
 * Journalisation silencieuse par défaut. On conserve les points de log plutôt
 * que de les supprimer : en cas de régression, passer DEBUG à true et
 * redéployer suffit pour retracer le cycle de vie, sans réécrire de code.
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

hubspot.extend<'crm.record.sidebar'>(
  ({ context, actions }: CrmExtensionProps) => (
    <CrmExtension context={context} actions={actions} />
  )
);

const CrmExtension = ({ actions }: CrmExtensionProps) => {
  const { fetchCrmObjectProperties, refreshObjectProperties } = actions;

  /*
   * Dernière valeur connue stockée dans une ref et non dans un state : elle
   * sert uniquement à la comparaison entre deux ticks, jamais au rendu. Un
   * state provoquerait des re-rendus inutiles et une closure obsolète dans le
   * callback d'intervalle.
   */
  const lastSignal = useRef<string | null>(null);
  // Tant que la lecture initiale n'a pas abouti, on ne déclenche aucun refresh
  // (sinon le premier tick rafraîchirait pour rien au montage).
  const initialized = useRef(false);

  // Normalisation : selon le type (datetime ou number) la valeur peut arriver
  // en chaîne ou en nombre. On compare toujours des chaînes.
  const normalize = useCallback(
    (value: unknown): string | null =>
      value === undefined || value === null ? null : String(value),
    []
  );

  useEffect(() => {
    // Vrai tant que le composant est monté : empêche toute écriture de ref ou
    // tout refresh déclenché par une requête encore en vol après démontage.
    let active = true;

    /* Lecture de la propriété tampon, partagée entre le montage et chaque tick. */
    const readSignal = () =>
      fetchCrmObjectProperties([SIGNAL_PROPERTY])
        .then((properties: Record<string, unknown> | undefined) => {
          if (!active) return;

          const nextSignal = normalize(properties?.[SIGNAL_PROPERTY]);

          // 1. Premier passage : on mémorise la valeur de référence, sans refresh.
          if (!initialized.current) {
            lastSignal.current = nextSignal;
            initialized.current = true;
            debugLog('Lecture initiale réussie, valeur =', nextSignal);
            return;
          }

          // 2. Ticks suivants : refresh uniquement sur changement réel.
          if (nextSignal === lastSignal.current) {
            return;
          }

          lastSignal.current = nextSignal;
          debugLog(
            'Changement détecté, déclenchement de refreshObjectProperties(), nouvelle valeur =',
            nextSignal
          );
          // Force HubSpot à recharger les propriétés affichées sur la fiche.
          refreshObjectProperties();
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
   * Rendu minimal : le SDK exige un retour JSX non nul (un rendu vide/null
   * fait échouer l'extension). On se limite à une ligne discrète.
   */
  return <Text>Synchronisation active</Text>;
};
