/**
 * Helper functions to manage Helius webhooks
 * Add/remove vault addresses dynamically as users create vaults
 */

const HELIUS_API_BASE = "https://api.helius.xyz/v0";

export interface HeliusWebhook {
    webhookID: string;
    webhookURL: string;
    transactionTypes: string[];
    accountAddresses: string[];
    webhookType: string;
}

/**
 * Add a vault address to an existing Helius webhook
 */
export async function addVaultToWebhook(
    webhookId: string,
    vaultAddress: string,
    apiKey: string
): Promise<void> {
    // First, get the current webhook configuration
    const response = await fetch(
        `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`Failed to get webhook: ${response.statusText}`);
    }

    const webhook: HeliusWebhook = await response.json();

    // Check if address is already in the list
    if (webhook.accountAddresses.includes(vaultAddress)) {
        console.log(`Vault ${vaultAddress} already in webhook`);
        return;
    }

    // Add the new vault address
    const updatedAddresses = [...webhook.accountAddresses, vaultAddress];

    // Update the webhook
    const updateResponse = await fetch(
        `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                transactionTypes: webhook.transactionTypes,
                accountAddresses: updatedAddresses,
            }),
        }
    );

    if (!updateResponse.ok) {
        throw new Error(`Failed to update webhook: ${updateResponse.statusText}`);
    }

    console.log(`Added vault ${vaultAddress} to webhook ${webhookId}`);
}

/**
 * Remove a vault address from a Helius webhook
 */
export async function removeVaultFromWebhook(
    webhookId: string,
    vaultAddress: string,
    apiKey: string
): Promise<void> {
    // Get current webhook configuration
    const response = await fetch(
        `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`
    );

    if (!response.ok) {
        throw new Error(`Failed to get webhook: ${response.statusText}`);
    }

    const webhook: HeliusWebhook = await response.json();

    // Remove the vault address
    const updatedAddresses = webhook.accountAddresses.filter(
        (addr) => addr !== vaultAddress
    );

    // Update the webhook
    const updateResponse = await fetch(
        `${HELIUS_API_BASE}/webhooks/${webhookId}?api-key=${apiKey}`,
        {
            method: "PUT",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                transactionTypes: webhook.transactionTypes,
                accountAddresses: updatedAddresses,
            }),
        }
    );

    if (!updateResponse.ok) {
        throw new Error(`Failed to update webhook: ${updateResponse.statusText}`);
    }

    console.log(`Removed vault ${vaultAddress} from webhook ${webhookId}`);
}

/**
 * Create a new Helius webhook
 */
export async function createHeliusWebhook(
    webhookURL: string,
    apiKey: string,
    initialVaultAddresses: string[] = []
): Promise<HeliusWebhook> {
    const response = await fetch(
        `${HELIUS_API_BASE}/webhooks?api-key=${apiKey}`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
            },
            body: JSON.stringify({
                webhookURL,
                transactionTypes: ["TRANSFER"],
                accountAddresses: initialVaultAddresses,
                webhookType: "enhanced",
            }),
        }
    );

    if (!response.ok) {
        const error = await response.text();
        throw new Error(`Failed to create webhook: ${error}`);
    }

    return await response.json();
}

