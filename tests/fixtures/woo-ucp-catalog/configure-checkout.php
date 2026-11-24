<?php
require_once '/wordpress/wp-load.php';

if (!defined('WC_VERSION') || WC_VERSION !== '11.3.1') {
    throw new RuntimeException('WooCommerce 11.3.1 is required');
}

update_option('woocommerce_coming_soon', 'no');
update_option('woocommerce_enable_guest_checkout', 'yes');
update_option('woocommerce_enable_signup_and_login_from_checkout', 'no');
update_option('woocommerce_default_country', 'US:CA');
update_option('woocommerce_allowed_countries', 'all');
update_option('woocommerce_ship_to_countries', 'all');
update_option('woocommerce_calc_taxes', 'no');
update_option('woocommerce_enable_coupons', 'yes');
WC_Install::create_pages();

$zone = new WC_Shipping_Zone();
$zone->set_zone_name('Synthetic US shipping');
$zone->add_location('US', 'country');
$zone->save();
$instance_id = $zone->add_shipping_method('flat_rate');
update_option('woocommerce_flat_rate_' . $instance_id . '_settings', [
    'title' => 'Fixture shipping',
    'tax_status' => 'none',
    'cost' => '5.00',
]);

$coupon = new WC_Coupon();
$coupon->set_code('fixture-dollar-off');
$coupon->set_discount_type('fixed_cart');
$coupon->set_amount('1.00');
$coupon->save();

file_put_contents('/wordpress/ucp-checkout-fixture.json', wp_json_encode([
    'checkoutUrl' => wc_get_checkout_url(),
    'guestEnabled' => get_option('woocommerce_enable_guest_checkout') === 'yes',
    'registrationRequired' => WC()->checkout()->is_registration_required(),
    'shippingAmount' => 500,
    'discountCode' => $coupon->get_code(),
    'discountAmount' => 100,
]));
