package dev.edge.vaultwallet;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.DialogInterface;
import android.content.SharedPreferences;
import android.hardware.biometrics.BiometricManager;
import android.hardware.biometrics.BiometricPrompt;
import android.os.CancellationSignal;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyPermanentlyInvalidatedException;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Keeps the wallet password encrypted under an Android Keystore key that only works after a
 * strong biometric check. The key can't leave the Keystore, and a newly enrolled fingerprint
 * permanently invalidates it.
 */
final class BiometricVault {
    interface Callback { void done(boolean ok, String value); }

    private static final String KEY = "vault_wallet_password_key";
    private static final String PREFS = "biometric";
    private final Activity activity;

    BiometricVault(Activity activity) { this.activity = activity; }

    private SharedPreferences prefs() { return activity.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    @SuppressWarnings("deprecation")
    boolean available() {
        BiometricManager manager = activity.getSystemService(BiometricManager.class);
        KeyguardManager keyguard = activity.getSystemService(KeyguardManager.class);
        return manager != null && keyguard != null && keyguard.isDeviceSecure()
                && manager.canAuthenticate() == BiometricManager.BIOMETRIC_SUCCESS;
    }

    // Each wallet has its own key and stored password. The first wallet keeps the names it always had.
    private static String suffix(String wallet) { return "main".equals(wallet) ? "" : ":" + wallet; }

    boolean enabled(String wallet) {
        return available() && prefs().contains("ct" + suffix(wallet));
    }

    void disable(String wallet) {
        String s = suffix(wallet);
        prefs().edit().remove("ct" + s).remove("iv" + s).apply();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            ks.deleteEntry(KEY + s);
        } catch (Exception ignored) { }
    }

    private SecretKey createKey(String wallet) throws Exception {
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(new KeyGenParameterSpec.Builder(KEY + suffix(wallet), KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(true)
                .setInvalidatedByBiometricEnrollment(true)
                .build());
        return gen.generateKey();
    }

    private SecretKey loadKey(String wallet) throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        return (SecretKey) ks.getKey(KEY + suffix(wallet), null);
    }

    void enable(final String wallet, final String password, final Callback cb) {
        try {
            disable(wallet);
            final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, createKey(wallet));
            prompt("Turn on fingerprint login", cipher, new Callback() {
                @Override public void done(boolean ok, String value) {
                    if (!ok) { disable(wallet); cb.done(false, value); return; }
                    try {
                        byte[] ct = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
                        prefs().edit()
                                .putString("ct" + suffix(wallet), Base64.encodeToString(ct, Base64.NO_WRAP))
                                .putString("iv" + suffix(wallet), Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                                .apply();
                        cb.done(true, "");
                    } catch (Exception e) {
                        disable(wallet);
                        cb.done(false, "Could not turn on fingerprint login.");
                    }
                }
            });
        } catch (Exception e) {
            disable(wallet);
            cb.done(false, "Could not turn on fingerprint login.");
        }
    }

    void unlock(final String wallet, final Callback cb) {
        try {
            final byte[] ct = Base64.decode(prefs().getString("ct" + suffix(wallet), ""), Base64.NO_WRAP);
            byte[] iv = Base64.decode(prefs().getString("iv" + suffix(wallet), ""), Base64.NO_WRAP);
            SecretKey key = loadKey(wallet);
            if (key == null || ct.length == 0) throw new KeyPermanentlyInvalidatedException();
            final Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, iv));
            prompt("Open Kusari Wallet", cipher, new Callback() {
                @Override public void done(boolean ok, String value) {
                    if (!ok) { cb.done(false, value); return; }
                    try {
                        cb.done(true, new String(cipher.doFinal(ct), StandardCharsets.UTF_8));
                    } catch (Exception e) {
                        cb.done(false, "Fingerprint login failed. Open with your password.");
                    }
                }
            });
        } catch (KeyPermanentlyInvalidatedException e) {
            disable(wallet);
            cb.done(false, "The fingerprints on this phone changed, so fingerprint login was turned off. Open with your password, then turn it on again.");
        } catch (Exception e) {
            cb.done(false, "Fingerprint login failed. Open with your password.");
        }
    }

    private void prompt(String title, Cipher cipher, final Callback cb) {
        BiometricPrompt prompt = new BiometricPrompt.Builder(activity)
                .setTitle(title)
                .setNegativeButton("Use password", activity.getMainExecutor(), new DialogInterface.OnClickListener() {
                    @Override public void onClick(DialogInterface dialog, int which) { cb.done(false, "cancelled"); }
                })
                .build();
        prompt.authenticate(new BiometricPrompt.CryptoObject(cipher), new CancellationSignal(), activity.getMainExecutor(),
                new BiometricPrompt.AuthenticationCallback() {
                    @Override public void onAuthenticationSucceeded(BiometricPrompt.AuthenticationResult result) {
                        cb.done(true, "");
                    }
                    @Override public void onAuthenticationError(int code, CharSequence message) {
                        boolean cancelled = code == BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED || code == BiometricPrompt.BIOMETRIC_ERROR_CANCELED;
                        cb.done(false, cancelled ? "cancelled" : String.valueOf(message));
                    }
                });
    }
}
