-- Optional phone for a credit (Accounts Receivable) sale, captured by the
-- waiter when the guest settles on account. Nullable: staff often know the
-- customer by name alone, so null means "not taken", never "no phone".
ALTER TABLE "restaurant_orders" ADD COLUMN "arCustomerPhone" TEXT;
